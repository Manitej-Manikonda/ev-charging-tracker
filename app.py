import os
import sqlite3
import random
import json
from datetime import datetime
from twilio.rest import Client
from flask import Flask, render_template, request, jsonify, session, redirect, url_for

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "ev-planner-demo-secret-change-me")
DB_NAME = "ev_platform.db"

OTP_STORE = {}
OTP_EXPIRY_SECONDS = 300

# THE FIX: Auto-migrate database to add license_plate column
def init_db_migrations():
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()
    try:
        cursor.execute("ALTER TABLE users ADD COLUMN name TEXT DEFAULT 'EV Driver'")
        cursor.execute("ALTER TABLE users ADD COLUMN vehicle_model TEXT DEFAULT 'Volt Compact 40'")
        cursor.execute("ALTER TABLE users ADD COLUMN battery_capacity REAL DEFAULT 40.0")
    except sqlite3.OperationalError:
        pass 
    
    try:
        cursor.execute("ALTER TABLE users ADD COLUMN license_plate TEXT DEFAULT 'TS 09 EV 0000'")
    except sqlite3.OperationalError:
        pass

    try:
        cursor.execute("ALTER TABLE stations ADD COLUMN port_statuses TEXT")
    except sqlite3.OperationalError:
        pass
        
    conn.commit()
    conn.close()

init_db_migrations()

def get_db():
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    return conn

def normalize_mobile(mobile):
    if not mobile: return None
    clean = ''.join(filter(str.isdigit, str(mobile)))
    return clean[-10:] if len(clean) >= 10 else None

# ==========================================
# DRIVER APP ROUTES
# ==========================================
@app.route("/")
def index():
    if "verified_mobile" not in session:
        return redirect(url_for("login"))
    return render_template("index.html")

@app.route("/login")
def login():
    return render_template("login.html")

@app.route("/register")
def register_page():
    return render_template("register.html")

@app.post("/api/register")
def api_driver_register():
    data = request.json or {}
    phone = normalize_mobile(data.get("mobile"))
    name = (data.get("name") or "").strip()
    license_plate = (data.get("license_plate") or "TS 09 EV 0000").strip().upper()
    vehicle_model = (data.get("vehicle_model") or "Volt Compact 40").strip()
    battery_capacity = float(data.get("battery_capacity", 40.0))

    if not phone or not name:
        return jsonify({"success": False, "message": "Valid name and 10-digit mobile number required."}), 400

    db = get_db()
    existing = db.execute("SELECT * FROM users WHERE phone = ?", (phone,)).fetchone()
    if existing:
        db.close()
        return jsonify({"success": False, "message": "Mobile number already registered. Please log in."}), 400

    db.execute('''
        INSERT INTO users (phone, name, license_plate, vehicle_model, battery_capacity, strikes, penalties, is_blocked)
        VALUES (?, ?, ?, ?, ?, 0, 0, 0)
    ''', (phone, name, license_plate, vehicle_model, battery_capacity))
    db.commit()
    db.close()

    session["verified_mobile"] = phone
    return jsonify({"success": True, "redirect": url_for("index")})

# Add your API credentials here (replace with your actual Twilio dashboard values)
twilio_sid = "YOUR_TWILIO_ACCOUNT_SID"
twilio_auth_token = "YOUR_TWILIO_AUTH_TOKEN"
TWILIO_PHONE_NUMBER = "+17372508034"

@app.post("/api/login")
def api_login():
    data = request.json
    mobile = normalize_mobile(data.get("mobile"))
    if not mobile: 
        return jsonify({"success": False, "message": "Invalid 10-digit mobile number"}), 400
    
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE phone = ?", (mobile,)).fetchone()
    db.close()
    
    if not user:
        return jsonify({"success": False, "message": "Number not registered. Please register your vehicle first!"}), 403
        
    otp = str(random.randint(100000, 999999))
    OTP_STORE[mobile] = otp
    print(f"DEBUG - OTP for {mobile} is {otp}")
    
    # Send the OTP directly to the frontend for a smooth, instant presentation
    return jsonify({"success": True, "message": "OTP Sent", "demo_otp": otp})

@app.post("/api/verify")
def api_verify():
    data = request.json
    mobile = normalize_mobile(data.get("mobile"))
    otp = data.get("otp")
    
    if OTP_STORE.get(mobile) == otp:
        session["verified_mobile"] = mobile
        # THE FIX: Removed the security loophole that automatically created blank profiles here
        return jsonify({"success": True, "redirect": url_for("index")})
        
    return jsonify({"success": False, "message": "Invalid OTP"}), 401

@app.get("/api/grid")
def api_grid():
    db = get_db()
    stations = db.execute("SELECT * FROM stations").fetchall()
    
    user_data = None
    history_logs = []
    
    if "verified_mobile" in session:
        user_phone = session["verified_mobile"]
        user = db.execute("SELECT * FROM users WHERE phone = ?", (user_phone,)).fetchone()
        
        if user:
            user_data = dict(user)
            
            # Fetch the past 7 days of charging history for this specific driver
            logs = db.execute('''
                SELECT 
                    s.created_at, 
                    st.name as station_name, 
                    s.active_min, 
                    s.idle_min, 
                    s.energy_kwh, 
                    s.total_cost
                FROM sessions s
                JOIN stations st ON s.station_id = st.id
                WHERE s.user_phone = ? AND s.created_at >= datetime('now', '-7 days')
                ORDER BY s.created_at DESC
            ''', (user_phone,)).fetchall()
            
            history_logs = [dict(l) for l in logs]
            
    db.close()
    
    # This specifically forces the "history" key to be sent to your F12 Network tab!
    return jsonify({
        "success": True,
        "stations": [dict(s) for s in stations],
        "user": user_data,
        "history": history_logs
    })

@app.post("/api/book-slot")
def book_slot():
    if "verified_mobile" not in session: return jsonify({"success": False, "message": "Unauthorized"}), 401
    phone = session["verified_mobile"]
    station_id = request.json.get("station_id")
    
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE phone = ?", (phone,)).fetchone()
    if user and user["is_blocked"]:
        db.close()
        return jsonify({"success": False, "message": "Account suspended. Pay fines to unlock."}), 403
        
    station = db.execute("SELECT * FROM stations WHERE id = ?", (station_id,)).fetchone()
    if not station or station["available_slots"] <= 0 or station["hardware_status"] != "Online":
        db.close()
        return jsonify({"success": False, "message": "Station full or offline."}), 400
        
    db.execute("UPDATE stations SET available_slots = available_slots - 1 WHERE id = ?", (station_id,))
    db.execute("UPDATE users SET active_booking_station_id = ? WHERE phone = ?", (station_id, phone))
    db.commit()
    db.close()
    return jsonify({"success": True})

@app.post("/api/cancel-booking")
def cancel_booking():
    if "verified_mobile" not in session: 
        return jsonify({"success": False, "message": "Unauthorized"}), 401
    
    phone = session["verified_mobile"]
    db = get_db()
    
    # Check if the user actually has an active booking to cancel
    user = db.execute("SELECT active_booking_station_id FROM users WHERE phone = ?", (phone,)).fetchone()
    
    if user and user["active_booking_station_id"]:
        station_id = user["active_booking_station_id"]
        # Return the slot to the station
        db.execute("UPDATE stations SET available_slots = MIN(total_slots, available_slots + 1) WHERE id = ?", (station_id,))
        # Clear the active booking from the user's profile
        db.execute("UPDATE users SET active_booking_station_id = NULL WHERE phone = ?", (phone,))
        db.commit()
        
    db.close()
    return jsonify({"success": True})

@app.post("/api/arrive-station")
def arrive_station():
    return jsonify({"success": True})

@app.post("/api/complete-session")
def complete_session():
    data = request.json
    energy_kwh = max(0, data.get("energy_kwh", 0))
    active_min, idle_min = max(0, data.get("active_min", 0)), max(0, data.get("idle_min", 0))
    station_id = data.get("station_id", "ST01") 
    phone = session.get("verified_mobile", "demo")
    
    energy_cost, active_cost, idle_cost, base_fee = energy_kwh * 15.0, active_min * 2.0, idle_min * 5.0, 20.0
    total = energy_cost + active_cost + idle_cost + base_fee
    invoice_id = f"INV-{random.randint(10000,99999)}"
    
    db = get_db()
    db.execute('''INSERT INTO sessions (invoice_id, station_id, user_phone, energy_kwh, active_min, idle_min, total_cost)
                  VALUES (?, ?, ?, ?, ?, ?, ?)''', (invoice_id, station_id, phone, energy_kwh, active_min, idle_min, total))
    db.execute("UPDATE stations SET available_slots = available_slots + 1 WHERE id = ?", (station_id,))
    db.execute("UPDATE users SET active_booking_station_id = NULL WHERE phone = ?", (phone,))
    db.commit()
    db.close()
    
    return jsonify({
        "success": True, 
        "invoice": {
            "energy_kwh": round(energy_kwh, 1), "energy_cost": round(energy_cost, 2), 
            "active_min": int(active_min), "active_cost": round(active_cost, 2), 
            "idle_min": int(idle_min), "idle_cost": round(idle_cost, 2), "total": round(total, 2)
        }
    })

# ==========================================
# PARTNER / CPO ONBOARDING ROUTES
# ==========================================
@app.route("/partner/register")
def partner_register_page():
    return render_template("partner_register.html")

@app.post("/api/partner/register")
def api_partner_register():
    data = request.json or {}
    username = (data.get("username") or "").strip()
    password = (data.get("password") or "").strip()
    station_name = (data.get("station_name") or "").strip()
    lat = float(data.get("lat", 17.4380))
    lon = float(data.get("lon", 78.3800))
    total_slots = int(data.get("total_slots", 4))
    charger_type = data.get("charger_type", "Fast Charger")
    speed_kw = int(data.get("speed_kw", 60))
    charging_minutes = int(data.get("charging_minutes", 30))
    guard_present = 1 if data.get("guard_present") else 0

    if not username or not password or not station_name:
        return jsonify({"success": False, "message": "Username, password, and station name are required."}), 400

    db = get_db()
    existing_user = db.execute("SELECT * FROM partners WHERE username = ?", (username,)).fetchone()
    if existing_user:
        db.close()
        return jsonify({"success": False, "message": "Username already taken."}), 400

    count = db.execute("SELECT COUNT(*) FROM stations").fetchone()[0]
    station_id = f"ST{count + 1:02d}"

    db.execute('''
        INSERT INTO stations (id, name, lat, lon, total_slots, available_slots, charger_type, speed_kw, charging_minutes, guard_present, hardware_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Online')
    ''', (station_id, station_name, lat, lon, total_slots, total_slots, charger_type, speed_kw, charging_minutes, guard_present))
    db.execute('''
        INSERT INTO partners (username, password, station_id)
        VALUES (?, ?, ?)
    ''', (username, password, station_id))

    db.commit()
    db.close()

    session["partner_id"] = username
    session["partner_station_id"] = station_id
    return jsonify({"success": True, "redirect": url_for("partner_dashboard")})

@app.route("/partner")
def partner_login():
    if "partner_id" in session: return redirect(url_for("partner_dashboard"))
    return render_template("partner_login.html")

@app.post("/api/partner/login")
def api_partner_login():
    data = request.json
    username, password = data.get("username"), data.get("password")
    db = get_db()
    partner = db.execute("SELECT * FROM partners WHERE username = ? AND password = ?", (username, password)).fetchone()
    db.close()
    
    if partner:
        session["partner_id"] = partner["username"]
        session["partner_station_id"] = partner["station_id"]
        return jsonify({"success": True, "redirect": url_for("partner_dashboard")})
    return jsonify({"success": False, "message": "Invalid credentials"}), 401

@app.route("/partner/dashboard")
def partner_dashboard():
    if "partner_id" not in session: return redirect(url_for("partner_login"))
    return render_template("partner_dashboard.html")

@app.get("/api/partner/data")
def partner_data():
    if not session.get("partner_station_id"): return jsonify({"success": False}), 401
    
    station_id = session["partner_station_id"]
    db = get_db()
    station = db.execute("SELECT * FROM stations WHERE id = ?", (station_id,)).fetchone()

    station_dict = dict(station)
    if not station_dict.get("port_statuses"):
        station_dict["port_statuses"] = ["Online"] * station_dict["total_slots"]
    else:
        station_dict["port_statuses"] = json.loads(station_dict["port_statuses"])
    
    # THE FIX: SQL JOIN to merge the Session Log with the User Table to get the Number Plate!
    sessions = db.execute('''
        SELECT s.*, u.license_plate 
        FROM sessions s 
        LEFT JOIN users u ON s.user_phone = u.phone 
        WHERE s.station_id = ? 
        ORDER BY s.created_at DESC LIMIT 50
    ''', (station_id,)).fetchall()
    
    today = datetime.utcnow().strftime('%Y-%m-%d')
    today_stats = db.execute("SELECT SUM(total_cost), SUM(energy_kwh) FROM sessions WHERE station_id = ? AND date(created_at) = ?", (station_id, today)).fetchone()
    today_rev = today_stats[0] or 0
    today_energy = today_stats[1] or 0
    total_rev = db.execute("SELECT SUM(total_cost) FROM sessions WHERE station_id = ?", (station_id,)).fetchone()[0] or 0

    daily_energy_query = db.execute('''
        SELECT date(created_at) as day, SUM(energy_kwh) as energy 
        FROM sessions WHERE station_id = ? GROUP BY date(created_at) ORDER BY day DESC LIMIT 7
    ''', (station_id,)).fetchall()
    db.close()
    
    return jsonify({
        "success": True,
        "station": station_dict,
        "sessions": [dict(s) for s in sessions],
        "total_revenue": round(total_rev, 2),
        "today_revenue": round(today_rev, 2),
        "today_energy": round(today_energy, 1),
        "daily_quota": 500.0,
        "trend_data": [{"day": row["day"], "energy": row["energy"]} for row in daily_energy_query]
    })

@app.post("/api/partner/hardware")
def update_hardware():
    if "partner_station_id" not in session: return jsonify({"success": False}), 401
    
    data = request.json
    port_idx = int(data.get("port_index"))
    new_status = data.get("status")
    station_id = session["partner_station_id"]
    
    print("\n=== HARDWARE UPDATE INITIATED ===")
    print(f"Station ID: {station_id} | Port Clicked: {port_idx} | New Status: {new_status}")
    
    db = get_db()
    station = db.execute("SELECT * FROM stations WHERE id = ?", (station_id,)).fetchone()
    
    if station["port_statuses"]:
        statuses = json.loads(station["port_statuses"])
    else:
        statuses = ["Online"] * station["total_slots"]
        
    old_status = statuses[port_idx]
    statuses[port_idx] = new_status
    
    current_slots = int(station["available_slots"])
    total_slots = int(station["total_slots"])
    
    print(f"Port {port_idx} was '{old_status}', changing to '{new_status}'")
    print(f"Slots BEFORE math: {current_slots} / {total_slots}")
    
    if old_status == "Online" and new_status != "Online":
        current_slots = max(0, current_slots - 1)
    elif old_status != "Online" and new_status == "Online":
        current_slots = min(total_slots, current_slots + 1)
        
    print(f"Slots AFTER math: {current_slots} / {total_slots}")
    
    overall_status = "Online"
    if all(s != "Online" for s in statuses):
        overall_status = "Maintenance"
        
    # 4. Save back to the database (keeping station_id as a string!)
    db.execute('''
        UPDATE stations 
        SET port_statuses = ?, 
            available_slots = ?,
            hardware_status = ?
        WHERE id = ?
    ''', (json.dumps(statuses), int(current_slots), overall_status, station_id))
    
    db.commit()
    db.close()
    
    print("=== DATABASE COMMIT SUCCESSFUL ===\n")
    return jsonify({"success": True})

@app.post("/api/partner/logout")
def partner_logout():
    session.pop("partner_id", None)
    session.pop("partner_station_id", None)
    return jsonify({"success": True})

@app.route("/api/nuke")
def nuke_database():
    db = get_db()
    
    # THE FIX: Reset the slots AND wipe the port_statuses array clean so they sync perfectly
    db.execute('''
        UPDATE stations 
        SET available_slots = total_slots, 
            port_statuses = NULL, 
            hardware_status = 'Online'
    ''')
    
    # Clear out any stuck active bookings for all users
    db.execute("UPDATE users SET active_booking_station_id = NULL")
    
    db.commit()
    db.close()
    return "<h1>✅ Database Perfectly Nuked! All ports and slots reset.</h1><p><a href='/'>Click here to go back</a></p>"

# ==========================================
# 🚨 CRITICAL SOS DISPATCH ROUTES 🚨
# ==========================================

@app.post("/api/sos")
def trigger_sos():
    if "verified_mobile" not in session: return jsonify({"success": False}), 401
    
    data = request.json
    db = get_db()
    
    # Auto-create the emergency table if it doesn't exist yet
    db.execute('''CREATE TABLE IF NOT EXISTS emergency_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        station_id TEXT,
        user_phone TEXT,
        user_plate TEXT,
        lat REAL,
        lon REAL,
        status TEXT DEFAULT 'Active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )''')
    
    # Grab the user's license plate
    user = db.execute("SELECT * FROM users WHERE phone = ?", (session["verified_mobile"],)).fetchone()
    plate = user["license_plate"] if user else "UNKNOWN"
    
    # Save the live alert to the database
    db.execute('''
        INSERT INTO emergency_alerts (station_id, user_phone, user_plate, lat, lon)
        VALUES (?, ?, ?, ?, ?)
    ''', (data.get("station_id"), session["verified_mobile"], plate, data.get("lat"), data.get("lon")))
    
    db.commit()
    db.close()
    return jsonify({"success": True})


@app.get("/api/partner/sos")
def get_partner_sos():
    if "partner_station_id" not in session: return jsonify({"success": False})
    
    db = get_db()
    
    # 1. Create the FULL table correctly if it doesn't exist at all
    db.execute('''CREATE TABLE IF NOT EXISTS emergency_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        station_id TEXT,
        user_phone TEXT,
        user_plate TEXT,
        lat REAL,
        lon REAL,
        status TEXT DEFAULT 'Active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )''')
    
    # 2. Try to search the table. If it's the broken one from earlier, 
    # Python will catch the error, drop the bad table, and build the right one!
    try:
        alerts = db.execute('''
            SELECT * FROM emergency_alerts 
            WHERE station_id = ? AND status = 'Active'
            ORDER BY created_at DESC
        ''', (session["partner_station_id"],)).fetchall()
    except Exception as e:
        db.execute("DROP TABLE IF EXISTS emergency_alerts")
        db.execute('''CREATE TABLE emergency_alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            station_id TEXT,
            user_phone TEXT,
            user_plate TEXT,
            lat REAL,
            lon REAL,
            status TEXT DEFAULT 'Active',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )''')
        alerts = []
        
    db.close()
    return jsonify({"success": True, "alerts": [dict(a) for a in alerts]})


@app.post("/api/partner/sos/resolve")
def resolve_partner_sos():
    if "partner_station_id" not in session: return jsonify({"success": False})
    
    alert_id = request.json.get("alert_id")
    db = get_db()
    
    # Mark the alert as handled so it disappears from the dashboard
    db.execute("UPDATE emergency_alerts SET status = 'Resolved' WHERE id = ?", (alert_id,))
    db.commit()
    db.close()
    
    return jsonify({"success": True})

if __name__ == "__main__":
    app.run(debug=True)