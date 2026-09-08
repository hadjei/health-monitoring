const firebaseConfig = {
    apiKey: "AIzaSyAjOQrTXuuqDcnNf4UP2aXBy17JvpdD2xI",
    authDomain: "esp-project-114dd.firebaseapp.com",
    databaseURL: "https://esp-project-114dd-default-rtdb.firebaseio.com",
    projectId: "esp-project-114dd",
    storageBucket: "esp-project-114dd.firebasestorage.app",
    messagingSenderId: "685391999885",
    appId: "1:685391999885:web:6dfdc5f5279fcaa47303c4",
    measurementId: "G-QY3N6JL2Q1"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const database = firebase.database();

// DOM Elements
const bpmVal = document.getElementById('bpm-val');
const spo2Val = document.getElementById('spo2-val');
const respVal = document.getElementById('resp-val');
const bpmStatus = document.getElementById('bpm-status');
const spo2Status = document.getElementById('spo2-status');
const respStatus = document.getElementById('resp-status');
const connectionDot = document.getElementById('connection-dot');
const connectionStatus = document.getElementById('connection-status');
const fingerBanner = document.getElementById('finger-banner');

// Chart Setup
const ctx = document.getElementById('vitalsChart').getContext('2d');
const maxDataPoints = 30; // Last 30 points

const vitalsChart = new Chart(ctx, {
    type: 'line',
    data: {
        labels: [],
        datasets: [
            {
                label: 'Heart Rate (BPM)',
                data: [],
                borderColor: '#e74c3c',
                backgroundColor: 'rgba(231, 76, 60, 0.1)',
                borderWidth: 2.5,
                yAxisID: 'y',
                tension: 0.35,
                pointRadius: 4
            },
            {
                label: 'SpO2 (%)',
                data: [],
                borderColor: '#2980b9',
                backgroundColor: 'rgba(41, 128, 185, 0.1)',
                borderWidth: 2.5,
                yAxisID: 'y1',
                tension: 0.35,
                pointRadius: 4
            },
            {
                label: 'Respiration Rate (BrPM)',
                data: [],
                borderColor: '#27ae60',
                backgroundColor: 'rgba(39, 174, 96, 0.1)',
                borderWidth: 2.5,
                yAxisID: 'y2',
                tension: 0.35,
                pointRadius: 4
            }
        ]
    },
    options: {
        responsive: true,
        interaction: {
            mode: 'index',
            intersect: false,
        },
        scales: {
            x: {
                display: true,
                title: { display: true, text: 'Time', font: { weight: 'bold' } },
                grid: { display: false }
            },
            y: {
                type: 'linear',
                display: true,
                position: 'left',
                title: { display: true, text: 'BPM', font: { weight: 'bold', color: '#e74c3c' } },
                min: 40,
                max: 160
            },
            y1: {
                type: 'linear',
                display: true,
                position: 'right',
                title: { display: true, text: 'SpO2 %', font: { weight: 'bold', color: '#2980b9' } },
                min: 80,
                max: 100,
                grid: { drawOnChartArea: false }
            },
            y2: {
                type: 'linear',
                display: false,
                min: 0,
                max: 40
            }
        }
    }
});

function setIdleState(message) {
    fingerBanner.style.display = "block";
    if (message) fingerBanner.textContent = message;
    connectionDot.className = "dot warning";
    connectionStatus.textContent = "Sensor Online: No Finger Detected";

    bpmVal.textContent = "--";
    spo2Val.textContent = "--";
    respVal.textContent = "--";

    bpmStatus.textContent = "No Finger";
    bpmStatus.className = "status-indicator status-idle";
    spo2Status.textContent = "No Finger";
    spo2Status.className = "status-indicator status-idle";
    respStatus.textContent = "No Finger";
    respStatus.className = "status-indicator status-idle";
}

function evaluateVitals(bpm, spo2, resp) {
    fingerBanner.style.display = "none";
    connectionDot.className = "dot online";
    connectionStatus.textContent = "Live Cloud Stream Active (Resting Vitals Steady)";

    // Heart Rate Evaluation
    if (bpm < 50) {
        bpmStatus.textContent = "Bradycardia";
        bpmStatus.className = "status-indicator status-warning";
    } else if (bpm > 105) {
        bpmStatus.textContent = "Elevated";
        bpmStatus.className = "status-indicator status-warning";
    } else {
        bpmStatus.textContent = "Normal (Resting)";
        bpmStatus.className = "status-indicator status-normal";
    }

    // SpO2 Evaluation
    if (spo2 < 93) {
        spo2Status.textContent = "Low Oxygen";
        spo2Status.className = "status-indicator status-warning";
    } else {
        spo2Status.textContent = "Normal";
        spo2Status.className = "status-indicator status-normal";
    }

    // Respiration Rate Evaluation
    if (resp < 10 || resp > 24) {
        respStatus.textContent = resp < 10 ? "Bradypnea" : "Tachypnea";
        respStatus.className = "status-indicator status-warning";
    } else {
        respStatus.textContent = "Normal";
        respStatus.className = "status-indicator status-normal";
    }
}

// Listen for live updates from Firebase RTDB
database.ref('vitals/current').on('value', (snapshot) => {
    const data = snapshot.val();
    if (!data) return;

    // Check Finger Detection State
    if (data.fingerDetected === false) {
        setIdleState("⚠️ NO FINGER DETECTED — Place your finger lightly and steadily on the MAX30102 sensor.");
        return;
    }

    // Finger is detected, but vitals are stabilizing
    if (!data.bpm || data.bpm === 0) {
        fingerBanner.style.display = "block";
        fingerBanner.textContent = "⏳ FINGER DETECTED — Calibrating optical signal and computing vitals...";
        fingerBanner.style.background = "#fff3cd";
        fingerBanner.style.color = "#856404";
        fingerBanner.style.border = "1px solid #ffeeba";
        connectionDot.className = "dot online";
        connectionStatus.textContent = "Sensor Online: Finger Detected (Acquiring Vitals...)";
        bpmVal.textContent = "--";
        spo2Val.textContent = "--";
        respVal.textContent = "--";
        bpmStatus.textContent = "Acquiring";
        bpmStatus.className = "status-indicator status-idle";
        spo2Status.textContent = "Acquiring";
        spo2Status.className = "status-indicator status-idle";
        respStatus.textContent = "Acquiring";
        respStatus.className = "status-indicator status-idle";
        return;
    }

    // Valid finger reading
    const bpm = Math.round(data.bpm);
    const spo2 = Math.round(data.spo2);
    const resp = data.respiration ? Math.round(data.respiration) : 15;

    bpmVal.textContent = bpm;
    spo2Val.textContent = spo2;
    respVal.textContent = resp;

    evaluateVitals(bpm, spo2, resp);

    // Plot on chart only if valid
    const timeLabel = new Date((data.timestamp || Date.now() / 1000) * 1000).toLocaleTimeString();

    vitalsChart.data.labels.push(timeLabel);
    vitalsChart.data.datasets[0].data.push(bpm);
    vitalsChart.data.datasets[1].data.push(spo2);
    vitalsChart.data.datasets[2].data.push(resp);

    if (vitalsChart.data.labels.length > maxDataPoints) {
        vitalsChart.data.labels.shift();
        vitalsChart.data.datasets[0].data.shift();
        vitalsChart.data.datasets[1].data.shift();
        vitalsChart.data.datasets[2].data.shift();
    }

    vitalsChart.update();
}, (error) => {
    connectionDot.className = "dot";
    connectionStatus.textContent = "Error connecting to Firebase: " + error.message;
});
