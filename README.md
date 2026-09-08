# IoT Remote Patient Monitoring System (ESP32 + MAX30102)

A real-time, clinical-inspired biomedical patient monitoring system using an **ESP32** and a **MAX30102** optical pulse oximetry sensor. The system acquires dual-wavelength photoplethysmography (PPG) waveforms, processes them via a dual-core DSP engine, streams live telemetry to **Google Firebase Realtime Database**, and visualizes vitals on a responsive web dashboard.

---

## Features

- **Heart Rate (BPM):** High-precision inter-beat interval (IBI) calculation with adaptive refractory periods ($0.55 \times \text{running IBI}$) and derivative upstroke slope verification to prevent dicrotic notch double-counting.
- **Blood Oxygen Saturation ($SpO_2$ %):** Beat-synchronized ratio-of-ratios ($R$) using an empirical quadratic calibration model calibrated for reflective optical path geometry ($SpO_2 = -18.0 \cdot R^2 + 7.5 \cdot R + 106.0$).
- **Respiration Rate (BrPM):** Isolated from Respiratory-Induced Intensity Variation (RIIV) using a 2nd-order Butterworth bandpass filter ($0.12\text{--}0.45\text{ Hz}$) and mean-centered zero-crossings with hysteresis.
- **Signal Quality Index (SQI):** Continuous assessment of Perfusion Index ($PI = \frac{AC_{pp}}{DC} \times 100\%$) and cross-channel optical correlation ($Red/IR$) to reject motion artifacts.
- **Dual-Core FreeRTOS Architecture:**
  - **Core 1 (High Priority):** $50.0\text{ Hz}$ sample-accurate DSP acquisition and filtering pipeline.
  - **Core 0 (Low Priority):** Asynchronous Wi-Fi management and Firebase Realtime Database TLS transmissions.
- **Real-Time Web Dashboard:**
  - Dynamic 3-series Chart.js visualization.
  - Contact detection status (`NO FINGER DETECTED`, `CALIBRATING`, `ONLINE`).
  - Automatic clinical alerting (bradycardia, tachycardia, desaturation, tachypnea).

---

## Hardware Pinout & Wiring

| MAX30102 Pin | ESP32 GPIO | Description |
| :--- | :--- | :--- |
| **VIN** | **3.3V** | Power Supply (3.3V DC) |
| **GND** | **GND** | Ground |
| **SDA** | **GPIO 21** | I2C Serial Data |
| **SCL** | **GPIO 22** | I2C Serial Clock |
| **INT** | *Not connected* | Interrupt (optional) |

---

## Project Structure

```text
iot-patient-monitor/
├── dashboard/
│   ├── index.html      # Responsive web dashboard UI
│   └── app.js          # Firebase listener & Chart.js real-time plot
├── firmware/
│   ├── platformio.ini  # PlatformIO environment & dependency configuration
│   └── src/
│       └── main.cpp    # Dual-core DSP & Firebase firmware
├── .gitignore
└── README.md
```

---

## Sensor & DSP Configuration

* **Sampling Rate:** $200\text{ Hz}$ raw sampling with $4\times$ hardware averaging $\to$ **$50.0\text{ Hz}$ effective output rate** ($20.0\text{ ms}$ per sample).
* **ADC Resolution:** 18-bit integration time ($411\text{ µs}$ pulse width).
* **LED Drive Current:** $\sim 7.0\text{ mA}$ ($0\text{x}24$) for tissue penetration without capillary blanching or photodiode saturation.
* **Cardiac Filter:** 2nd-order Direct Form II Transposed Biquad Bandpass ($0.5\text{--}4.0\text{ Hz}$, Butterworth).
* **Respiration Filter:** 2nd-order Direct Form II Transposed Biquad Bandpass ($0.12\text{--}0.45\text{ Hz}$, Butterworth).

---

## Getting Started

### 1. Prerequisites
* [VS Code](https://code.visualstudio.com/) with the [PlatformIO IDE](https://platformio.org/) extension installed.
* ESP32 Development Board (CP2102 or CH340 USB driver).
* MAX30102 / MAX30105 Optical Sensor Module.

### 2. Firmware Configuration
Open `firmware/src/main.cpp` and configure your local Wi-Fi and Firebase credentials:
```cpp
#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

#define FIREBASE_HOST "your-project-default-rtdb.firebaseio.com"
#define FIREBASE_AUTH "YOUR_DATABASE_SECRET"
```

### 3. Build & Upload Firmware
1. Open the `firmware/` folder in VS Code with PlatformIO.
2. Connect the ESP32 via USB.
3. Click the PlatformIO **Upload** arrow ($\to$) on the status bar.
4. Open the Serial Monitor at **115200 baud** to view real-time diagnostic output.

### 4. Run the Web Dashboard
1. Navigate to the `dashboard/` directory.
2. Open `index.html` directly in any web browser or serve it using Live Server.
3. Place your finger lightly and steadily on the MAX30102 sensor.
4. Watch live vitals stream to the dashboard in real-time.

---

## License

This project is licensed under the MIT License.
>>>>>>> 0a2a274 (Initial commit: ESP32 MAX30102 clinical-grade vital signs monitor with web dashboard)
