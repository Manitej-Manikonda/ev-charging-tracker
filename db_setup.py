import sqlite3
import os

DB_NAME = "ev_platform.db"

def initialize_database():
    # Remove old database if you are rebuilding from scratch
    if os.path.exists(DB_NAME):
        os.remove(DB_NAME)
        
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()

    # 1. STATIONS TABLE
    cursor.execute('''
    CREATE TABLE stations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        total_slots INTEGER NOT NULL,
        available_slots INTEGER NOT NULL,
        charger_type TEXT NOT NULL,
        speed_kw INTEGER NOT NULL,
        charging_minutes INTEGER NOT NULL,
        guard_present BOOLEAN NOT NULL,
        hardware_status TEXT DEFAULT 'Online' -- Online, Maintenance, Damaged
    )
    ''')

    # 2. PARTNERS (STATION MANAGERS) TABLE
    cursor.execute('''
    CREATE TABLE partners (
        username TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        station_id TEXT NOT NULL,
        FOREIGN KEY(station_id) REFERENCES stations(id)
    )
    ''')

    # 3. USERS (DRIVERS) TABLE
    cursor.execute('''
    CREATE TABLE users (
        phone TEXT PRIMARY KEY,
        strikes INTEGER DEFAULT 0,
        penalties INTEGER DEFAULT 0,
        is_blocked BOOLEAN DEFAULT 0,
        active_booking_station_id TEXT DEFAULT NULL
    )
    ''')

    # 4. CHARGING SESSIONS & INVOICES (LOGBOOK)
    cursor.execute('''
    CREATE TABLE sessions (
        invoice_id TEXT PRIMARY KEY,
        station_id TEXT NOT NULL,
        user_phone TEXT NOT NULL,
        energy_kwh REAL,
        active_min INTEGER,
        idle_min INTEGER,
        total_cost REAL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    ''')

    # --- PRE-LOAD DATA ---
    stations_data = [
        ("ST01", "HITEC City Fast Charge", 17.4474, 78.3762, 4, 2, "Fast Charger", 60, 25, True),
        ("ST02", "Madhapur EV Hub", 17.4486, 78.3908, 4, 1, "CCS", 50, 30, True),
        ("ST03", "Gachibowli Green Charge", 17.4401, 78.3489, 6, 3, "Type 2", 22, 55, False),
        ("ST04", "Kondapur Power Point", 17.4598, 78.3651, 4, 0, "Normal Charger", 11, 75, True),
        ("ST05", "Financial District Charge Park", 17.4217, 78.3432, 5, 2, "Fast Charger", 80, 20, True),
        ("ST06", "Jubilee Hills Checkpost", 17.4294, 78.4069, 4, 4, "CCS", 50, 30, True),
        ("ST07", "Secunderabad Metro EV", 17.4337, 78.4983, 3, 1, "Fast Charger", 60, 25, False),
        ("ST08", "Banjara Hills Rd 12", 17.4082, 78.4411, 5, 2, "Type 2", 22, 55, True),
        ("ST09", "Miyapur X Roads", 17.4950, 78.3619, 2, 0, "CCS", 50, 30, True),
        ("ST10", "Ameerpet Hub", 17.4357, 78.4446, 6, 3, "Normal Charger", 11, 75, False)
    ]

    cursor.executemany('''
    INSERT INTO stations (id, name, lat, lon, total_slots, available_slots, charger_type, speed_kw, charging_minutes, guard_present)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', stations_data)

    # Generate a partner account for each station (Username: partner_ST01, Password: password123)
    partners_data = [(f"partner_{s[0]}", "password123", s[0]) for s in stations_data]
    
    cursor.executemany('''
    INSERT INTO partners (username, password, station_id)
    VALUES (?, ?, ?)
    ''', partners_data)

    conn.commit()
    conn.close()
    print(f"✅ Success! {DB_NAME} created with 10 stations and 10 partner accounts.")

if __name__ == "__main__":
    initialize_database()