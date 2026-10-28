let map, carMarker, bestMarker;
let routeLine = null;
let bookingInterval = null;
let simInterval = null;

const state = {
  pos: [17.44450, 78.37720], battery: 72, driving: false, charging: false,
  stations: [], evaluated: [], best: null, exactDestination: null
};

function renderHistory(historyList) {
  const tbody = document.getElementById("historyTableBody");
  if (!tbody) return;
  
  if (!historyList || historyList.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:#64748b;">No charging sessions in the past 7 days.</td></tr>';
    return;
  }
  
  tbody.innerHTML = historyList.map(log => {
    // Format the timestamp nicely
    const dateObj = new Date(log.created_at + 'Z'); 
    const dateStr = dateObj.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    
    // Combine active charging time + idle penalty time
    const totalTime = (log.active_min || 0) + (log.idle_min || 0);
    
    return `
      <tr>
        <td>${dateStr}</td>
        <td><strong>${log.station_name}</strong></td>
        <td>${totalTime.toFixed(0)} min</td>
        <td style="color:#10b981; font-weight:bold;">${parseFloat(log.energy_kwh).toFixed(2)} kWh</td>
        <td style="color:#3b82f6; font-weight:bold;">₹${parseFloat(log.total_cost).toFixed(2)}</td>
      </tr>
    `;
  }).join("");
}

// ==========================================
// MAP & UI INITIALIZATION
// ==========================================
function initMap() {
  map = L.map('map', { zoomControl: false }).setView(state.pos, 14);
  // Move zoom controls to the bottom right, matching Google Maps standard
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  // Google Maps Light Mode Tile Layer
  L.tileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
    maxZoom: 20,
    attribution: '&copy; Google Maps'
  }).addTo(map);

  // Google Maps standard Blue Dot for user location
  const blueDot = `<div style="background-color: #4285F4; width: 16px; height: 16px; border-radius: 50%; border: 3px solid white; box-shadow: 0 0 6px rgba(0,0,0,0.4);"></div>`;

  carMarker = L.marker(state.pos, {
    icon: L.divIcon({ className: 'custom-div-icon', html: blueDot, iconSize: [22, 22], iconAnchor: [11, 11] })
  }).addTo(map);
}

function updateCarMarker() {
  carMarker.setLatLng(state.pos);
  document.getElementById("coords").textContent = `${state.pos[0].toFixed(5)}, ${state.pos[1].toFixed(5)}`;
  if(state.exactDestination) drawRoute(state.pos, [state.exactDestination.lat, state.exactDestination.lon]);
}

function updateBatteryUI() {
  document.getElementById("batteryText").textContent = `${Math.floor(state.battery)}%`;
  document.getElementById("batteryBar").style.width = `${Math.floor(state.battery)}%`;
  document.getElementById("rangeText").textContent = `${Math.floor(state.battery * 2)} km`;
}

async function drawRoute(start, end) {
  if (routeLine) map.removeLayer(routeLine);

  try {
    // OSRM coordinates format: {longitude},{latitude};{longitude},{latitude}
    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${start[1]},${start[0]};${end[1]},${end[0]}?overview=full&geometries=geojson`;
    
    const res = await fetch(osrmUrl);
    const data = await res.json();

    if (data.routes && data.routes.length > 0) {
      const primaryRoute = data.routes[0];
      
      // Convert OSRM GeoJSON [lon, lat] pairs to Leaflet [lat, lon]
      const latLngs = primaryRoute.geometry.coordinates.map(coord => [coord[1], coord[0]]);

      routeLine = L.polyline(latLngs, {
        color: '#00d9ff',
        weight: 5,
        opacity: 0.9,
        lineJoin: 'round'
      }).addTo(map);

      map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });

      // Automatically sync actual road distance and driving ETA to Action Hub
      const realKm = (primaryRoute.distance / 1000).toFixed(1);
      const realMins = Math.ceil(primaryRoute.duration / 60);

      const distEl = document.getElementById("bestDistance");
      const travelEl = document.getElementById("bestTravel");
      if (distEl) distEl.textContent = `${realKm} km`;
      if (travelEl) travelEl.textContent = `${realMins} min`;
    }
  } catch (err) {
    console.warn("OSRM routing unavailable, using straight fallback:", err);
    // Fallback straight line if network drops
    routeLine = L.polyline([start, end], { color: '#00d9ff', weight: 4, dashArray: '5, 10' }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
  }
}

function logMsg(msg, icon) {
  const c = document.getElementById("notifications");
  const d = document.createElement("div");
  d.className = "log-item";
  d.innerHTML = `<div class="log-icon">${icon}</div><div class="log-content">${msg}</div><div class="log-time">${new Date().toLocaleTimeString()}</div>`;
  c.prepend(d);
}

// ==========================================
// DATA FETCHING & DAA ALGORITHM
// ==========================================

function enableLiveDeviceGPS() {
  if (!navigator.geolocation) {
    return alert("Geolocation is not supported by your browser.");
  }

  logMsg("Activating real-time hardware GPS stream...", "⌖");

  navigator.geolocation.watchPosition(
    (position) => {
      const { latitude, longitude } = position.coords;
      state.pos = [latitude, longitude];

      updateCarMarker();
      map.setView(state.pos, 15);
      
      // Re-run DAA algorithm with live position
      runDAA();
    },
    (err) => {
      console.warn("Live GPS Error:", err.message);
      logMsg("GPS signal weak or permission denied.", "⚠");
    },
    {
      enableHighAccuracy: true, // Uses device GPS hardware over cell towers
      maximumAge: 3000,         // Cache readings for at most 3 seconds
      timeout: 10000
    }
  );
}

async function fetchGrid() {
  try {
    const res = await fetch("/api/grid?t=" + Date.now(), { cache: "no-store" });
    const data = await res.json();
    if(data.success) {
      state.stations = data.stations;
      renderMarkers();

      if (data.history && typeof renderHistory === "function") {
          renderHistory(data.history);
      }
      
      const sc = document.getElementById("strikeCount");
      const pa = document.getElementById("penaltyAmount");
      const ba = document.getElementById("blockedBanner");
      const vId = document.getElementById("vehicleId"); // Grab the Vehicle ID element
      
      if(data.user) {
        if(sc) sc.textContent = data.user.strikes;
        if(pa) pa.textContent = data.user.penalties;
        
        // THE FIX: Inject the actual registered license plate into the Driver UI!
        if(vId && data.user.license_plate) {
            vId.textContent = data.user.license_plate;
        }

        if(ba) {
          if(data.user.is_blocked) ba.classList.remove("hidden");
          else ba.classList.add("hidden");
        }
      }
    }
  } catch(e) {}
}

let markersList = [];
function renderMarkers() {
  markersList.forEach(m => map.removeLayer(m));
  markersList = [];

  // SVG for standard Google Red Pin
  const redPin = `<svg viewBox="0 0 24 24" width="28" height="28" stroke="#8a2019" stroke-width="1" fill="#EA4335"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>`;

  // SVG for selected Google Green Pin
  const greenPin = `<svg viewBox="0 0 24 24" width="40" height="40" stroke="#1d5c31" stroke-width="1" fill="#34A853"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>`;

  state.stations.forEach(st => {
    if(st.hardware_status === "Maintenance" || st.hardware_status === "Damaged") return;
    const isBest = state.best && state.best.id === st.id;
    
    const iconHTML = isBest ? greenPin : redPin;
    const iconSize = isBest ? [40, 40] : [28, 28];
    const iconAnchor = isBest ? [20, 40] : [14, 28]; // Anchors the sharp bottom tip of the pin to the exact coordinate

    const m = L.marker([st.lat, st.lon], { 
      icon: L.divIcon({ className: 'custom-div-icon', html: iconHTML, iconSize: iconSize, iconAnchor: iconAnchor }) 
    }).addTo(map);
    
    m.bindTooltip(`<b>${st.name}</b><br>Slots: ${st.available_slots}/${st.total_slots}`, { direction: 'top', offset: [0, -iconSize[1]] });
    markersList.push(m);
  });
}

function runDAA() {
  state.evaluated = state.stations.map(st => {
    let score = 0;
    const dist = Math.sqrt(Math.pow(st.lat - state.pos[0], 2) + Math.pow(st.lon - state.pos[1], 2)) * 111;
    const dScore = Math.max(0, 25 - (dist * 2));
    const aScore = st.available_slots > 0 ? 20 : -50;
    const tScore = st.speed_kw > 50 ? 15 : (st.speed_kw > 22 ? 10 : 5);
    const bScore = state.battery < 20 ? (dist < 3 ? 20 : 0) : 10;
    const cScore = st.guard_present ? 15 : 10;
    
    if(st.hardware_status !== "Online") score = -100;
    else score = dScore + aScore + tScore + bScore + cScore;
    
    return { ...st, dist, dScore, aScore, tScore, bScore, cScore, totalScore: Math.round(score) };
  }).sort((a,b) => b.totalScore - a.totalScore);
  
  function renderHistory(historyList) {
  const tbody = document.getElementById("historyTableBody");
  if (!tbody) return;
  
  if (!historyList || historyList.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:#64748b;">No charging sessions in the past 7 days.</td></tr>';
    return;
  }
  
  tbody.innerHTML = historyList.map(log => {
    // Format the timestamp nicely for the user
    const dateObj = new Date(log.created_at + 'Z'); 
    const dateStr = dateObj.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    
    // Combine active charging time + idle penalty time
    const totalTime = (log.active_min || 0) + (log.idle_min || 0);
    
    return `
      <tr>
        <td>${dateStr}</td>
        <td><strong>${log.station_name}</strong></td>
        <td>${totalTime.toFixed(0)} min</td>
        <td style="color:#10b981; font-weight:bold;">${parseFloat(log.energy_kwh).toFixed(2)} kWh</td>
        <td style="color:#3b82f6; font-weight:bold;">₹${parseFloat(log.total_cost).toFixed(2)}</td>
      </tr>
    `;
  }).join("");
}

  renderTable();
  if(state.evaluated.length > 0 && state.evaluated[0].totalScore > 0) {
    state.best = state.evaluated[0];
    document.getElementById("recommendationEmpty").classList.add("hidden");
    document.getElementById("recommendationContent").classList.remove("hidden");
    document.getElementById("bestName").textContent = state.best.name;
    document.getElementById("bestScore").textContent = state.best.totalScore;
    document.getElementById("bestDistance").textContent = state.best.dist.toFixed(1) + " km";
    document.getElementById("bestTravel").textContent = Math.ceil(state.best.dist * 3) + " min";
    document.getElementById("bestSlots").textContent = state.best.available_slots + "/" + state.best.total_slots;
    document.getElementById("bestTime").textContent = state.best.charging_minutes + " min";
    logMsg(`${state.best.name} selected with score ${state.best.totalScore}.`, "♜");
    renderMarkers();
  }
}

function renderTable() {
  const tbody = document.getElementById("stationTable");
  const sort = document.getElementById("sortSelect").value;
  let sorted = [...state.evaluated];
  if(sort === "distance") sorted.sort((a,b) => a.dist - b.dist);
  
  // THE FIX: Check if the user currently has an active booking
  const hasBooking = state.exactDestination !== null;
  
  tbody.innerHTML = sorted.map((st, i) => {
    const isFull = st.available_slots === 0 || st.hardware_status !== "Online";
    
    // THE FIX: Disable the button if the station is full OR if a booking is active
    const isDisabled = isFull || hasBooking;
    
    // THE FIX: Change the button text to "Booked" for the station they chose
    const btnText = (hasBooking && state.exactDestination.id === st.id) ? "Booked" : "Book";
    
    return `<tr>
      <td>${i+1}</td>
      <td><strong>${st.name}</strong></td>
      <td>${st.dist.toFixed(2)} km</td>
      <td><span class="status ${isFull ? 'red' : 'green'}">${isFull ? 'Full/Off' : `Avail ${st.available_slots}/${st.total_slots}`}</span></td>
      <td><span class="tag cyan">${st.charger_type}</span></td>
      <td>${st.charging_minutes} min</td>
      <td><span class="tag ${st.guard_present ? 'green' : ''}">${st.guard_present ? 'Yes' : 'No'}</span></td>
      <td>${st.dScore.toFixed(1)}</td><td>${st.aScore}</td><td>${st.tScore}</td><td>${st.bScore}</td><td>${st.cScore}</td>
      <td><strong>${st.totalScore}</strong></td>
      <td><button class="table-book-btn ${isDisabled?'disabled':''}" data-id="${st.id}" ${isDisabled?'disabled':''}>${btnText}</button></td>
    </tr>`;
  }).join("");
}

// ==========================================
// BOOKING & DYNAMIC UX MODES
// ==========================================
const stationTableBody = document.getElementById("stationTable");
if (stationTableBody) {
  stationTableBody.addEventListener("click", (e) => {
    if (e.target.classList.contains("table-book-btn")) {
      e.stopPropagation(); 
      if (e.target.disabled) return; 
      const stationId = e.target.getAttribute("data-id");
      processBooking(stationId);
    }
  });
}

async function processBooking(stationId) {
  const station = state.evaluated.find(s => s.id === stationId);
  if (!station) return alert("Invalid station selected.");
  
  try {
    const res = await fetch("/api/book-slot", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({station_id: station.id})
    });
    const data = await res.json();
    if(!data.success) return alert(data.message); 
    
    state.best = station;
    state.exactDestination = station;
    
    const widget = document.getElementById("bookingWidget");
    if(widget) {
      widget.classList.remove("hidden");
      const statusText = document.getElementById("bookingStatusText");
      if(statusText) statusText.innerHTML = `Session booked at <b style="color:#fff;">${station.name}</b>.<br>Head there now!<br><span id="bookingCountdown" style="display:block; font-size:24px; font-family:monospace; color:#b6ff3f; margin-top:8px;">30:00</span>`;
    }
    
    // Timer Logic
    if(bookingInterval) clearInterval(bookingInterval);
    let timeLeft = 1800; // 30 minutes
    bookingInterval = setInterval(() => {
      timeLeft--;
      const min = Math.floor(timeLeft / 60).toString().padStart(2, '0');
      const sec = (timeLeft % 60).toString().padStart(2, '0');
      const display = document.getElementById("bookingCountdown");
      if(display) display.textContent = `${min}:${sec}`;
      if(timeLeft <= 0) {
        clearInterval(bookingInterval);
        if(display) display.textContent = "EXPIRED";
      }
    }, 1000);

    renderTable();
    alert(`Success! Slot booked at ${station.name}. You have 30 minutes to arrive.`);
  } catch(err) { console.error("Booking error:", err); }
}

// --- SOS CRITICAL BATTERY DISPATCH ---
async function triggerCriticalSOS() {
    // 1. Ensure we have GPS coordinates and a nearest station calculated
    if (!state.best || !state.pos) {
        alert("Cannot send SOS: Live location or nearest station not identified.");
        return;
    }
    
    try {
        // 2. Transmit the payload to the Python backend
        const res = await fetch("/api/sos", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                station_id: state.best.id,
                lat: state.pos[0],
                lon: state.pos[1]
            })
        });
        
        const data = await res.json();
        if (data.success) {
            alert(`🚨 SOS TRANSMITTED! \n\nYour coordinates and vehicle data have been sent to ${state.best.name}. A towing/mobile-charging unit is being dispatched to your location.`);
        }
    } catch (err) {
        console.error("SOS transmission failed", err);
    }
}

function setDashboardMode(mode, stationName = "") {
  const btnDrive = document.getElementById("startBtn");
  const btnStop = document.getElementById("stopBtn");
  const btnDrain = document.getElementById("decBtn");
  const btnZero = document.getElementById("zeroBtn");
  const btnPlugin = document.getElementById("startChargingBtn");
  const btnCharge = document.getElementById("incBtn");
  const btnCheckout = document.getElementById("completeBtn");
  const navBtn = document.getElementById("navigateBtn");
  const teleportBtn = document.getElementById("goSpotBtn");
  const comparisonTable = document.querySelector(".comparison-panel");
  const actionText = document.getElementById("bookingStatusText");

  if (mode === "default") {
    if(btnDrive) btnDrive.style.display = "block";
    if(btnStop) btnStop.style.display = "block";
    if(btnDrain) btnDrain.style.display = "block";
    if(btnZero) btnZero.style.display = "block";
    if(btnPlugin) btnPlugin.style.display = "none";
    if(btnCharge) btnCharge.style.display = "none";
    if(btnCheckout) btnCheckout.style.display = "none";
    if(navBtn) navBtn.style.display = "inline-block";
    if(teleportBtn) teleportBtn.style.display = "inline-block";
    if(comparisonTable) { comparisonTable.style.opacity = "1"; comparisonTable.style.pointerEvents = "auto"; }
  } 
  else if (mode === "arrived") {
    if(btnDrive) btnDrive.style.display = "none";
    if(btnStop) btnStop.style.display = "none";
    if(btnDrain) btnDrain.style.display = "none";
    if(btnZero) btnZero.style.display = "none";
    if(btnPlugin) { btnPlugin.style.display = "block"; btnPlugin.style.background = "#b6ff3f"; btnPlugin.style.color = "#080d10"; }
    if(btnCharge) btnCharge.style.display = "none";
    if(btnCheckout) btnCheckout.style.display = "none";
    if(navBtn) navBtn.style.display = "none";
    if(teleportBtn) teleportBtn.style.display = "none";
    if(comparisonTable) { comparisonTable.style.opacity = "0.3"; comparisonTable.style.pointerEvents = "none"; }
    if(actionText) actionText.innerHTML = `<span style="font-size:30px;">📍</span><br><b style="color:#b6ff3f; font-size:18px;">Arrived at ${stationName}</b><br>Please plug in your vehicle.`;
    if(bookingInterval) clearInterval(bookingInterval); // Stop timer on arrival
  }
  else if (mode === "charging") {
    if(btnPlugin) btnPlugin.style.display = "none";
    if(btnCharge) btnCharge.style.display = "block";
    if(btnCheckout) { btnCheckout.style.display = "block"; btnCheckout.style.background = "#00d9ff"; btnCheckout.style.color = "#080d10"; }
    if(actionText) actionText.innerHTML = `<span style="font-size:30px;">⚡</span><br><b style="color:#00d9ff; font-size:18px;">Charging in Progress</b><br>Click Checkout when finished.`;
  }
}

// ==========================================
// SESSION CHECKOUT & HARDWARE SIMULATION
// ==========================================
const finalCheckoutBtn = document.getElementById("completeBtn");
if (finalCheckoutBtn) {
  finalCheckoutBtn.onclick = async () => {
    if (!state.best || !state.best.id) return alert("Error: No station selected.");
    const mockEnergy = (Math.random() * 20 + 10).toFixed(1); 
    const mockActive = Math.floor(Math.random() * 40 + 20); 
    const mockIdle = Math.floor(Math.random() * 15); 
    try {
      const res = await fetch("/api/complete-session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ station_id: state.best.id, energy_kwh: parseFloat(mockEnergy), active_min: mockActive, idle_min: mockIdle })
      });
      const data = await res.json();
      if (data.success) {
        const modal = document.getElementById("paymentModalOverlay");
        if (modal) {
          modal.classList.remove("hidden");
          document.getElementById("invEnergy").textContent = data.invoice.energy_kwh;
          document.getElementById("invEnergyCost").textContent = data.invoice.energy_cost.toFixed(2);
          document.getElementById("invActive").textContent = data.invoice.active_min;
          document.getElementById("invActiveCost").textContent = data.invoice.active_cost.toFixed(2);
          document.getElementById("invIdle").textContent = data.invoice.idle_min;
          document.getElementById("invIdleCost").textContent = data.invoice.idle_cost.toFixed(2);
          document.getElementById("invTotal").textContent = data.invoice.total.toFixed(2);
        }
      }
    } catch (err) {}
  };
}

const updateSimUI = () => {
  state.battery = Math.max(0, Math.min(100, state.battery));
  updateBatteryUI();
  if(state.battery === 0) logMsg("CRITICAL: Battery depleted.", "⚠");
};

// ==========================================
// BINDINGS & EVENT LISTENERS
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
  initMap();
  fetchGrid();
  setInterval(fetchGrid, 5000);
  
  document.getElementById("findBtn").onclick = runDAA;
  document.getElementById("sortSelect").onchange = renderTable;
  
  setDashboardMode("default");

  // Teleport Button
  const tpBtn = document.getElementById("goSpotBtn");
  if(tpBtn) {
    tpBtn.addEventListener("click", () => {
      if(state.best) {
        state.pos = [state.best.lat, state.best.lon];
        state.exactDestination = null; 
        if(routeLine) { map.removeLayer(routeLine); routeLine = null; }
        
        updateCarMarker();
        map.setView(state.pos, 15); // Safe zoom level
        setDashboardMode("arrived", state.best.name);
        fetch("/api/arrive-station", { method: "POST" }).catch(e=>{});
      }
    });
  }
  
  // Hardware Simulation Controls
  const btnDrive = document.getElementById("startBtn");
  if(btnDrive) btnDrive.addEventListener("click", () => {
    if(simInterval) clearInterval(simInterval);
    document.getElementById("vehicleStatus").textContent = "Driving";
    simInterval = setInterval(() => { state.battery -= 0.5; updateSimUI(); }, 2000);
  });

  const btnStop = document.getElementById("stopBtn");
  if(btnStop) btnStop.addEventListener("click", () => {
    if(simInterval) clearInterval(simInterval);
    document.getElementById("vehicleStatus").textContent = "Idle";
  });

  const btnDrain = document.getElementById("decBtn");
  if(btnDrain) btnDrain.addEventListener("click", () => { state.battery -= 5; updateSimUI(); });

  const btnCharge = document.getElementById("incBtn");
  if(btnCharge) btnCharge.addEventListener("click", () => { state.battery += 5; updateSimUI(); });

  const btnZero = document.getElementById("zeroBtn");
  if(btnZero) btnZero.addEventListener("click", () => { state.battery = 0; updateSimUI(); triggerCriticalSOS(); });

  const plugBtn = document.getElementById("startChargingBtn");
  if(plugBtn) plugBtn.addEventListener("click", () => setDashboardMode("charging"));

  const payBtn = document.getElementById("confirmPaymentBtn");
  if(payBtn) {
    payBtn.addEventListener("click", () => {
      document.getElementById("paymentModalOverlay").classList.add("hidden");
      setDashboardMode("default");
      const widget = document.getElementById("bookingWidget");
      if(widget) widget.classList.add("hidden");
      state.exactDestination = null;
      fetchGrid();
      
      renderTable(); // <--- THE FIX: Unlocks the table buttons after checkout
      alert("Payment Successful! Slot released.");
    });
  }

  // THE FIX: Wire up the Reset Telemetry button for quick demo resets
  const resetBtn = document.getElementById("resetBtn");
  if(resetBtn) {
    resetBtn.addEventListener("click", async () => {
      // THE FIX: Always tell the backend to cancel lingering bookings, 
      // even if the frontend forgot about them after a page refresh!
      try {
        await fetch("/api/cancel-booking", { method: "POST" });
      } catch(e) { console.error("Cancel failed:", e); }

      // 2. Reset all local frontend states
      state.exactDestination = null;
      state.best = null;
      if(routeLine) { map.removeLayer(routeLine); routeLine = null; }
      if(bookingInterval) clearInterval(bookingInterval);
      
      setDashboardMode("default");
      const widget = document.getElementById("bookingWidget");
      if(widget) widget.classList.add("hidden");
      
      const recContent = document.getElementById("recommendationContent");
      const recEmpty = document.getElementById("recommendationEmpty");
      if(recContent) recContent.classList.add("hidden");
      if(recEmpty) recEmpty.classList.remove("hidden");
      
      // 3. Fetch the fresh database grid so the slot instantly returns to normal in the table
      await fetchGrid(); 
      
      renderTable(); 
      logMsg("Telemetry reset and booking cancelled.", "↻");
    });
  }
  // Enable Live GPS Toggle
  const liveGpsBtn = document.getElementById("liveGpsBtn");
  if (liveGpsBtn) {
    liveGpsBtn.addEventListener("click", () => {
      enableLiveDeviceGPS();
      liveGpsBtn.textContent = "🟢 Live GPS Active";
      liveGpsBtn.style.borderColor = "#10b981";
      liveGpsBtn.style.color = "#10b981";
    });
  }
  // --- REAL-TIME CPO TELEMETRY POLLING ---
  // Automatically fetch fresh station data every 4 seconds
  // --- REAL-TIME CPO TELEMETRY POLLING (ULTIMATE BYPASS) ---
  // --- REAL-TIME CPO TELEMETRY POLLING (ULTIMATE BYPASS) ---
  setInterval(async () => {
    try {
      // 1. Force a raw fetch that aggressively blocks all browser caching
      const res = await fetch("/api/grid?bypass=" + new Date().getTime(), {
          method: "GET",
          headers: { 
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0"
          }
      });
      const data = await res.json();

      console.log("RAW SERVER DATA:", data);
      
      if (data.success) {
          // 2. Overwrite the raw map memory
          state.stations = data.stations;
          
          // 3. THE FIX: Re-run the Dynamic Allocation Algorithm!
          // This recalculates `state.evaluated` with the new slots and automatically 
          // updates the sidebar table and map pins.
          if (typeof runDAA === "function") {
              runDAA();
          }

          // THE FIX: Push the history data to the new table UI!
          if (data.history && typeof renderHistory === "function") {
              renderHistory(data.history);
          }
          
          console.log(`Live sync! Station 1 now has: ${data.stations[0].available_slots} slots.`);
      }
    } catch (err) {
      console.error("Telemetry sync failed:", err);
    }
  }, 4000);
});