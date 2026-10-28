# Electric Vehicle Charging Station Planner

A complete working college-project prototype built with **Python Flask + JavaScript + Leaflet + OpenStreetMap**.

## Problem Statement
Electric vehicle drivers need to choose charging stations using multiple factors instead of simply selecting the closest station. This project evaluates distance, battery feasibility, station availability, charging time, charger type and guard availability.

## Objectives
- Track/simulate an EV location.
- Monitor battery level.
- Show charging stations on an interactive map.
- Calculate real place names from coordinates using OpenStreetMap Nominatim reverse geocoding.
- Recommend a station using a DAA-based multi-factor algorithm.
- Simulate low-battery alerts, guard notification and charging.
- Demonstrate data structures, ranking and time complexity.

## Main Features
1. Live browser geolocation with permission.
2. Simulated vehicle route around the station dataset.
3. Automatic battery drain during movement.
4. Low and critical battery alerts.
5. Ten editable Hyderabad sample stations with charger, slot and guard details.
6. Station comparison table.
7. DAA recommendation engine.
8. Leaflet interactive map.
9. Route visualization between vehicle and recommended station.
10. Charging progress simulation.
11. Notification center.
12. Guard notification simulation.
13. Real location names through reverse geocoding.
14. Slot booking with a 30-minute arrival window, no-show penalties and strike blocking.
15. Itemized charging invoices, simulated UPI/card checkout and anomaly alerts.

## DAA Algorithm

For every station:

`Score = Distance Score + Availability Score + Charging Time Score + Battery Safety Score + Charger Type Score + Guard Score`

### Distance
Closer stations receive more points.

`DistanceScore = max(0, 25 - distance_km * 4)`

### Availability
- Available slot: +20
- Full station: -50

### Charging time
Faster charging receives more points.

`ChargingScore = max(0, 20 - charging_minutes * 0.20)`

### Battery safety
The prototype estimates:
- usable battery = 50 kWh
- consumption = 0.20 kWh/km
- 5% safety margin

A station is feasible when the EV has enough battery to reach it with the safety margin.

### Charger type
- Fast Charger: 15
- CCS: 14
- Type 2: 10
- Normal Charger: 7

Guard availability adds +5.

The algorithm does **not** simply select the nearest station.

## Data Structures
- Python list/array for stations.
- Python dictionaries/objects for station and vehicle records.
- List of evaluated candidates.
- Sorting for ranking.
- `heapq` is discussed as an optional priority-queue approach.

## Time Complexity
For `n` stations:
- Haversine distance: **O(1)** per station.
- Station evaluation: **O(n)**.
- Sorting/ranking: **O(n log n)**.
- Priority-queue ranking can be **O(n log k)** for top-k selection.
- Reverse geocoding: external network operation, not part of the DAA complexity.

## Architecture
```text
Browser
  |
  +-- Leaflet Map / OpenStreetMap
  +-- Geolocation API
  +-- Simulation Engine
  +-- Dashboard UI
  |
  v
Flask Backend
  +-- Vehicle/recommendation API
  +-- DAA scoring engine
  +-- Distance calculation
  +-- Station data
  +-- Reverse geocoding proxy
  +-- Guard notification simulation
```

## Run
### Windows
```bash
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Open:
`http://127.0.0.1:5000`

### Real GPS
Click **Use My Live Location** and allow browser location permission.

For best browser GPS support, use `localhost` or `127.0.0.1`. A deployed HTTPS site is recommended for real devices.

## Real Location Names
The app sends latitude/longitude to the Flask backend, which calls **OpenStreetMap Nominatim reverse geocoding**. If the service is unavailable, the dashboard falls back to showing coordinates.

For production deployment, follow Nominatim's usage policy and consider a dedicated geocoding provider.

## Simulation
Controls:
- Start Vehicle
- Stop Vehicle
- Increase Battery
- Decrease Battery
- Find Best Station
- Start Charging
- Complete Charging

The vehicle marker moves through a predefined route and battery decreases automatically.
Bookings expire after 30 minutes; use **Fast-Forward / Simulate 30m Expiry** for a demo. Five no-shows block further bookings. Charging invoices use ₹15/kWh, ₹2/active minute, ₹5/idle minute and a ₹20 session fee. Payment screens are simulations and do not process payment details.

Use **Send Demo SMS** to add a test-message preview to the dashboard notification feed; this action never contacts an SMS provider. Confirming checkout creates a dummy transaction reference and marks the invoice PAID without charging money.

To send real SMS, configure `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM_NUMBER`. To send guard dispatch SMS to a real configured station contact, also set `EV_GUARD_PHONE`. Without these settings, notifications are simulated.

## Future Enhancements
- Google Maps/Mapbox routing.
- Real station APIs.
- Login and user profiles.
- MySQL/PostgreSQL persistence.
- Real charger reservation/payment.
- Traffic-aware ETA.
- ML-based charging demand prediction.
- Dynamic electricity-price optimization.
- Multiple EVs and fleet management.


## 0% Emergency Workflow
When the battery reaches exactly 0%:
- The simulation stops.
- A full-screen emergency interface appears.
- The current location is shown.
- The geographically nearest station is identified.
- Distance, slot availability, charger type and guard status are displayed.
- A simulated SMS/message notification is added.
- If the station has a guard, the existing guard-notification simulation is triggered.
- `CALL EMERGENCY SUPPORT` and `CALL NEAREST STATION` use `tel:` demo links. They are not real emergency services.
- `GET HELP` displays a simulated successful help request.

The demo control **SET BATTERY TO 0%** triggers the complete workflow immediately.

Battery messages:
- `<= 20%`: Low Battery – Find a charging station.
- `<= 10%`: Critical Battery – Charging station recommended immediately.
- `= 0%`: Emergency workflow.

## About Section
The dashboard now contains an About section with the project description, key features, algorithm flow, and technology stack.


## Automatic Low-Battery Phone Message Simulation
The emergency screen is **not shown just because the battery is low**.

- At **20% or below**, the dashboard shows a low-battery warning and starts a simulated phone-message service.
- At **10% or below**, the dashboard changes to the critical-battery warning while continuing the simulated phone messages.
- A simulated phone message is added immediately when the threshold is reached and then repeats **every 2 minutes** while the battery remains at or below 20%.
- At exactly **0%**, the recurring low-battery timer stops and the full emergency workflow opens automatically.

### Important prototype limitation
A normal Flask/JavaScript application cannot send a real SMS to a phone by itself. The project's phone messages are therefore explicitly marked **SIMULATED**. To send real SMS messages, connect a service such as Twilio or another SMS provider and store the recipient number securely on the backend.


## Mobile Login + Verified Battery Alerts

The dashboard is now protected by a mobile-number login.

### Login flow
1. Enter a 10-digit Indian mobile number.
2. Request OTP.
3. Verify the 6-digit OTP.
4. The verified number is stored in the Flask session.
5. The dashboard opens only after verification.

### Low-battery alert
When the verified vehicle battery falls to **20% or below**, the application:
- shows the low-battery warning,
- sends an alert to the verified mobile number,
- repeats the registered-mobile alert every 2 minutes while the battery remains at or below 20%,
- changes the dashboard message to critical at 10%,
- opens the existing emergency workflow at exactly 0%.

### Real SMS / OTP
The project includes a provider-ready `send_sms()` function. For a real SMS system, configure Twilio:

```text
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=...
FLASK_SECRET_KEY=...
```

Then install:

```bash
pip install twilio
```

Without Twilio configuration, the application deliberately runs in **DEMO MODE** and displays the OTP/alert as simulated output rather than falsely claiming that an SMS was delivered.


## Exact Navigation
The **Navigate** button now:
1. Uses the vehicle's current latitude/longitude as the starting point.
2. Uses the selected station's exact latitude/longitude as the destination.
3. Moves the map to the exact station.
4. Requests an actual driving route through the OSRM routing service.
5. Draws the road route on the Leaflet map.
6. Shows the routed distance and estimated travel time.
7. Falls back to a direct map route if the road-routing service is temporarily unavailable.


## Go to Spot
A **📍 Go to Spot** button is placed beside **Navigate** in the recommendation panel.

- **Navigate** requests and displays the actual road route to the selected station.
- **Go to Spot** then moves the Leaflet map directly to the station's exact latitude/longitude.
- The exact station marker is highlighted and labeled **EXACT SPOT**.
- The notification panel shows the exact coordinates used.
