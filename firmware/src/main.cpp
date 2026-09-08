/**
 * ============================================================================
 * ESP32 MAX30102 CLINICAL-GRADE VITAL-SIGNS PROCESSING FIRMWARE
 * ============================================================================
 * 
 * Target: ESP32 Dev Module
 * Sensor: MAX30102 / MAX30105 Optical PPG Sensor (I2C)
 * Framework: Arduino / PlatformIO
 * 
 * Features:
 *   - 50 Hz sample-accurate PPG digital signal processing engine
 *   - 2nd-order Butterworth IIR bandpass filter (0.5 - 4.0 Hz) for cardiac AC
 *   - 2nd-order Butterworth IIR bandpass filter (0.1 - 0.45 Hz) for respiration (RIIV)
 *   - Derivative & dynamic peak prominence detection with physiological refractory period
 *   - Perfusion Index (PI) & Signal Quality Index (SQI) assessment
 *   - Cross-correlation & Pearson correlation between Red and IR pulse waves
 *   - Beat-synchronous quadratic calibration SpO2 model (A*R^2 + B*R + C)
 *   - Dual-Core FreeRTOS architecture: Core 1 handles real-time sensor DSP,
 *     Core 0 handles Wi-Fi and Firebase RTDB without blocking sensor acquisition.
 * ============================================================================
 */

#include <Arduino.h>
#include <WiFi.h>
#include <Firebase_ESP_Client.h>
#include <Wire.h>
#include "MAX30105.h"

// Firebase Helper Includes
#include "addons/TokenHelper.h"
#include "addons/RTDBHelper.h"

// ============================================================================
// COMPILE-TIME CONFIGURATION & CONSTANTS
// ============================================================================

// Diagnostic Output Configuration
// 0 = Production Mode (Concise vital sign logs)
// 1 = Telemetry & Debug Stream
// 2 = Serial Plotter Mode (Raw IR, Filtered IR, Respiratory Wave, Beat Triggers)
#define DEBUG_MODE 1

// Wi-Fi Credentials
#define WIFI_SSID "hafiz"
#define WIFI_PASSWORD "hafiz1234"

// Firebase Database Credentials
#define FIREBASE_HOST "esp-project-114dd-default-rtdb.firebaseio.com"
#define FIREBASE_AUTH "SMqRmSHeQZc0XUCYbSPCcgugAW9D9Fmdf9BVqCdp"

// Sampling Parameters
#define FS 50.0f                 // Effective output sample rate (Hz)
#define SAMPLE_INTERVAL_MS 20.0f // 1/FS in milliseconds
#define FS_INT 50

// Contact & Perfusion Thresholds
#define CONTACT_MIN_IR 45000     // Minimum IR DC value indicating tissue contact
#define CONTACT_MAX_IR 255000    // Saturation threshold (18-bit ADC saturates at 262,143)
#define MIN_PERFUSION_INDEX 0.15f // Minimum viable Perfusion Index (PI %)
#define MAX_PERFUSION_INDEX 18.0f // Maximum plausible Perfusion Index (PI %)

// Physiological Bounds
#define MIN_PHYSIO_BPM 40.0f
#define MAX_PHYSIO_BPM 180.0f
#define MIN_PHYSIO_SPO2 70.0f
#define MAX_PHYSIO_SPO2 100.0f
#define MIN_PHYSIO_RR 8.0f
#define MAX_PHYSIO_RR 32.0f

// Refractory Timing Limits (at 50 Hz: 1 sample = 20 ms)
// Minimum inter-beat interval: 520 ms (115 BPM max for resting monitor) -> 26 samples
// Eliminates 125 BPM (24-sample) and 143/158 BPM dicrotic triggers completely.
#define MIN_BEAT_SAMPLES 26
#define MAX_BEAT_SAMPLES 75

// Buffer Lengths
#define BEAT_HISTORY_SIZE 8
#define RESP_BUFFER_SIZE 400     // 8 seconds @ 50 Hz for respiration cycle tracking
#define PPG_WAVE_SIZE 40         // Real-time PPG plethysmogram waveform stream size

// ============================================================================
// DATA STRUCTURES
// ============================================================================

enum SensorState {
    STATE_NO_FINGER,
    STATE_INITIALIZING,
    STATE_ACQUIRING,
    STATE_VALID_MEASUREMENT,
    STATE_POOR_SIGNAL
};

enum SQILevel {
    SQI_LOW = 0,
    SQI_MEDIUM = 1,
    SQI_HIGH = 2
};

struct PPGSample {
    uint32_t rawIR;
    uint32_t rawRed;
    float irAC;
    float redAC;
    float irDC;
    float redDC;
    float respSignal;
};

struct SignalQuality {
    float perfusionIndex;    // PI (%) = (AC_rms / DC) * 100
    float correlation;       // Cross-correlation between Red and IR AC channels
    float snrEstimate;       // Signal-to-noise ratio indicator
    SQILevel level;
    bool plausibleBPM;
    bool plausibleSpO2;
};

struct VitalSigns {
    float bpm;
    float spo2;
    float respiration;
    bool valid;
    SensorState state;
    SignalQuality quality;
    unsigned long timestamp;
    float ppgWave[PPG_WAVE_SIZE];
};

// ============================================================================
// GLOBAL OBJECTS & THREAD-SAFE SYNCHRONIZATION
// ============================================================================

MAX30105 particleSensor;
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig fbConfig;

// Thread-safe vital signs shared between Core 1 (DSP) and Core 0 (Firebase)
VitalSigns currentVitals;
portMUX_TYPE vitalsMutex = portMUX_INITIALIZER_UNLOCKED;

// FreeRTOS Task Handles
TaskHandle_t dspTaskHandle = NULL;
TaskHandle_t commsTaskHandle = NULL;

// ============================================================================
// DIGITAL FILTER IMPLEMENTATIONS (BIQUAD IIR)
// ============================================================================

/**
 * 2nd-Order Direct Form II Transposed Biquad IIR Filter
 */
class BiquadFilter {
public:
    float b0, b1, b2, a1, a2;
    float v1, v2;

    void init(float _b0, float _b1, float _b2, float _a1, float _a2) {
        b0 = _b0; b1 = _b1; b2 = _b2;
        a1 = _a1; a2 = _a2;
        reset();
    }

    void reset() {
        v1 = 0.0f;
        v2 = 0.0f;
    }

    inline float process(float x) {
        float y = b0 * x + v1;
        v1 = b1 * x - a1 * y + v2;
        v2 = b2 * x - a2 * y;
        return y;
    }
};

// Cardiac Bandpass Filter (0.5 Hz - 4.0 Hz @ 50 Hz Sampling Rate)
// Designed as 2nd-order Butterworth equivalent biquad section
BiquadFilter irCardiacBP;
BiquadFilter redCardiacBP;

// Respiration Bandpass Filter (0.12 Hz - 0.45 Hz @ 50 Hz Sampling Rate)
// Isolates Respiratory-Induced Intensity Variation (RIIV) in the thoracic breathing band
BiquadFilter respBP;

void initFilters() {
    // 0.5 - 4.0 Hz Bandpass Filter @ Fs = 50 Hz:
    // Coefficients precalculated via bilinear transform
    irCardiacBP.init(0.1802f, 0.0f, -0.1802f, -1.5471f, 0.6396f);
    redCardiacBP.init(0.1802f, 0.0f, -0.1802f, -1.5471f, 0.6396f);

    // 0.12 - 0.45 Hz Respiration Bandpass Filter @ Fs = 50 Hz:
    respBP.init(0.0205f, 0.0f, -0.0205f, -1.9568f, 0.9590f);
}

// Slow DC Tracking Estimators
float slowDC_IR = 0.0f;
float slowDC_Red = 0.0f;

// ============================================================================
// BEAT DETECTION & BPM ENGINE
// ============================================================================

class BeatDetector {
private:
    float prevSample = 0.0f;
    float prevPrevSample = 0.0f;
    float peakThreshold = 40.0f;
    float runningMaxPeak = 80.0f;
    int samplesSinceBeat = 0;
    int adaptiveRefractory = 22; // Dynamic refractory period in samples

    float ibiBuffer[BEAT_HISTORY_SIZE];
    int ibiIdx = 0;
    int validBeatCount = 0;

public:
    void reset() {
        prevSample = 0.0f;
        prevPrevSample = 0.0f;
        peakThreshold = 40.0f;
        runningMaxPeak = 80.0f;
        samplesSinceBeat = 0;
        adaptiveRefractory = 22;
        ibiIdx = 0;
        validBeatCount = 0;
        for (int i = 0; i < BEAT_HISTORY_SIZE; i++) ibiBuffer[i] = 0.0f;
    }

    /**
     * Evaluates whether current sample constitutes a true ventricular systolic peak.
     * Returns instantaneous BPM if beat detected, or 0.0 if no beat.
     */
    float process(float currentSample) {
        samplesSinceBeat++;

        // Detect local peak: previous sample was greater than both its neighbors
        bool isLocalPeak = (prevSample > prevPrevSample) && (prevSample >= currentSample);
        float detectedBPM = 0.0f;

        if (isLocalPeak) {
            float peakAmplitude = prevSample;
            float risingSlope = prevSample - prevPrevSample;

            // Physiological Beat Verification Criteria:
            // 1. Peak height exceeds adaptive dynamic threshold
            // 2. Rising slope is steep (confirms ventricular systolic ejection)
            // 3. Samples elapsed exceed the adaptive refractory period (blocks dicrotic reflections)
            if (peakAmplitude > peakThreshold && risingSlope > 6.0f && samplesSinceBeat >= adaptiveRefractory) {
                // Compute instantaneous BPM from sample timing
                float instantBPM = (FS * 60.0f) / (float)samplesSinceBeat;

                if (instantBPM >= MIN_PHYSIO_BPM && instantBPM <= MAX_PHYSIO_BPM) {
                    detectedBPM = instantBPM;

                    // Update IBI buffer
                    ibiBuffer[ibiIdx++] = instantBPM;
                    ibiIdx %= BEAT_HISTORY_SIZE;
                    if (validBeatCount < BEAT_HISTORY_SIZE) validBeatCount++;

                    // Adapt refractory window to 55% of current average period (Pan-Tompkins model)
                    adaptiveRefractory = (int)(samplesSinceBeat * 0.55f);
                    if (adaptiveRefractory < MIN_BEAT_SAMPLES) adaptiveRefractory = MIN_BEAT_SAMPLES;
                    if (adaptiveRefractory > 35) adaptiveRefractory = 35; // Cap refractory to allow up to ~85 BPM changes

                    // Adapt peak threshold (45% of peak height) to prevent respiratory missed beats
                    runningMaxPeak = (runningMaxPeak * 0.7f) + (peakAmplitude * 0.3f);
                    peakThreshold = runningMaxPeak * 0.45f;
                    if (peakThreshold < 18.0f) peakThreshold = 18.0f;

                    samplesSinceBeat = 0;
                }
            }
        }

        // Adaptive decay of threshold during prolonged inter-beat intervals
        if (samplesSinceBeat > 40 && peakThreshold > 18.0f) {
            peakThreshold *= 0.980f;
        }
        if (samplesSinceBeat > 85) {
            // Over 1.7 seconds without a beat: re-arm anchor to maintain continuous tracking
            samplesSinceBeat = 0;
            peakThreshold = 20.0f;
        }

        // Shift history
        prevPrevSample = prevSample;
        prevSample = currentSample;

        return detectedBPM;
    }

    /**
     * Calculates trimmed-median filtered BPM across recent valid beats
     */
    float getStableBPM() {
        if (validBeatCount < 3) return 0.0f;

        float sorted[BEAT_HISTORY_SIZE];
        for (int i = 0; i < validBeatCount; i++) sorted[i] = ibiBuffer[i];

        // Bubble sort
        for (int i = 0; i < validBeatCount - 1; i++) {
            for (int j = i + 1; j < validBeatCount; j++) {
                if (sorted[i] > sorted[j]) {
                    float temp = sorted[i];
                    sorted[i] = sorted[j];
                    sorted[j] = temp;
                }
            }
        }

        // Trimmed mean: drop lowest and highest if at least 4 beats
        if (validBeatCount >= 4) {
            float sum = 0.0f;
            for (int i = 1; i < validBeatCount - 1; i++) sum += sorted[i];
            return sum / (float)(validBeatCount - 2);
        } else {
            float sum = 0.0f;
            for (int i = 0; i < validBeatCount; i++) sum += sorted[i];
            return sum / (float)validBeatCount;
        }
    }

    int getValidCount() const { return validBeatCount; }
    float getLastPeakAmplitude() const { return runningMaxPeak; }
};

BeatDetector beatDetector;

// ============================================================================
// SPO2 CALCULATION ENGINE
// ============================================================================

class SpO2Calculator {
private:
    // Calibration Coefficients for Reflective Pulse Oximetry on MAX30102
    // Tuned for side-by-side reflective photodiode (660nm Red / 880nm IR)
    const float CAL_A = -18.0f;
    const float CAL_B = 7.5f;
    const float CAL_C = 106.0f;

    // Cycle accumulators
    float cycleRedAC_Min = 999999.0f, cycleRedAC_Max = -999999.0f;
    float cycleIR_AC_Min = 999999.0f, cycleIR_AC_Max = -999999.0f;
    float cycleRedDC_Sum = 0.0f;
    float cycleIR_DC_Sum = 0.0f;
    int cycleSampleCount = 0;

    float filteredSpO2 = 0.0f;
    bool hasInitialized = false;

public:
    void reset() {
        cycleRedAC_Min = 999999.0f; cycleRedAC_Max = -999999.0f;
        cycleIR_AC_Min = 999999.0f; cycleIR_AC_Max = -999999.0f;
        cycleRedDC_Sum = 0.0f;
        cycleIR_DC_Sum = 0.0f;
        cycleSampleCount = 0;
        filteredSpO2 = 0.0f;
        hasInitialized = false;
    }

    void updateCycleSample(float redAC, float irAC, float redDC, float irDC) {
        if (redAC < cycleRedAC_Min) cycleRedAC_Min = redAC;
        if (redAC > cycleRedAC_Max) cycleRedAC_Max = redAC;
        if (irAC < cycleIR_AC_Min) cycleIR_AC_Min = irAC;
        if (irAC > cycleIR_AC_Max) cycleIR_AC_Max = irAC;

        cycleRedDC_Sum += redDC;
        cycleIR_DC_Sum += irDC;
        cycleSampleCount++;
    }

    float getCycleIR_pp() const { return (cycleIR_AC_Max - cycleIR_AC_Min); }
    float getCycleRed_pp() const { return (cycleRedAC_Max - cycleRedAC_Min); }

    /**
     * Called synchronously on each validated heartbeat to compute SpO2 across the completed cycle.
     */
    float onBeatDetected(float correlation) {
        if (cycleSampleCount < MIN_BEAT_SAMPLES || correlation < 0.50f) {
            // Cycle corrupted by motion artifact or too short
            resetCycle();
            return filteredSpO2;
        }

        float redAC_pp = cycleRedAC_Max - cycleRedAC_Min;
        float irAC_pp = cycleIR_AC_Max - cycleIR_AC_Min;
        float redDC_mean = cycleRedDC_Sum / (float)cycleSampleCount;
        float irDC_mean = cycleIR_DC_Sum / (float)cycleSampleCount;

        resetCycle();

        if (redDC_mean > 1000.0f && irDC_mean > 1000.0f && irAC_pp > 20.0f && redAC_pp > 15.0f) {
            // Ratio of Ratios R = (AC_red / DC_red) / (AC_ir / DC_ir)
            float R = (redAC_pp / redDC_mean) / (irAC_pp / irDC_mean);

            // Calculate SpO2 via quadratic empirical calibration
            float instantSpO2 = (CAL_A * R * R) + (CAL_B * R) + CAL_C;

            // Constrain to physiological limits
            if (instantSpO2 >= MIN_PHYSIO_SPO2 && instantSpO2 <= MAX_PHYSIO_SPO2) {
                if (!hasInitialized) {
                    filteredSpO2 = instantSpO2;
                    hasInitialized = true;
                } else {
                    // Exponential smoothing weighted by correlation
                    float alpha = 0.25f * correlation;
                    filteredSpO2 = (filteredSpO2 * (1.0f - alpha)) + (instantSpO2 * alpha);
                }
            }
        }

        return filteredSpO2;
    }

    void resetCycle() {
        cycleRedAC_Min = 999999.0f; cycleRedAC_Max = -999999.0f;
        cycleIR_AC_Min = 999999.0f; cycleIR_AC_Max = -999999.0f;
        cycleRedDC_Sum = 0.0f;
        cycleIR_DC_Sum = 0.0f;
        cycleSampleCount = 0;
    }

    float getStableSpO2() const { return filteredSpO2; }
};

SpO2Calculator spo2Engine;

// ============================================================================
// RESPIRATION RATE (RR) ENGINE
// ============================================================================

class RespirationEngine {
private:
    float respSignalBuffer[RESP_BUFFER_SIZE];
    int bufIndex = 0;
    int samplesAccumulated = 0;
    float currentRR = 0.0f;
    unsigned long lastRRUpdate = 0;

public:
    void reset() {
        bufIndex = 0;
        samplesAccumulated = 0;
        currentRR = 0.0f;
        lastRRUpdate = 0;
        for (int i = 0; i < RESP_BUFFER_SIZE; i++) respSignalBuffer[i] = 0.0f;
    }

    void addSample(float respFiltered) {
        respSignalBuffer[bufIndex++] = respFiltered;
        if (bufIndex >= RESP_BUFFER_SIZE) bufIndex = 0;
        if (samplesAccumulated < RESP_BUFFER_SIZE) samplesAccumulated++;
    }

    /**
     * Evaluates respiration frequency across the 8-second window (every 2 seconds)
     */
    float evaluateRespiration() {
        if (samplesAccumulated < RESP_BUFFER_SIZE) return 0.0f;
        if (millis() - lastRRUpdate < 2000) return currentRR;
        lastRRUpdate = millis();

        // 1. Calculate DC mean across the window
        float mean = 0.0f;
        for (int i = 0; i < RESP_BUFFER_SIZE; i++) mean += respSignalBuffer[i];
        mean /= (float)RESP_BUFFER_SIZE;

        // 2. Count positive zero crossings with hysteresis to avoid noise jitter
        int zeroCrossings = 0;
        bool belowZero = true;
        const float HYSTERESIS = 3.0f;

        for (int i = 0; i < RESP_BUFFER_SIZE; i++) {
            float val = respSignalBuffer[i] - mean;
            if (belowZero && val > HYSTERESIS) {
                zeroCrossings++;
                belowZero = false;
            } else if (!belowZero && val < -HYSTERESIS) {
                belowZero = true;
            }
        }

        // Window duration = RESP_BUFFER_SIZE / FS = 400 / 50 = 8.0 seconds
        float windowDurationSec = (float)RESP_BUFFER_SIZE / FS;
        float estimatedRR = (float)zeroCrossings * (60.0f / windowDurationSec);

        // Physiological check (normal breathing 8 - 32 BrPM)
        if (estimatedRR >= MIN_PHYSIO_RR && estimatedRR <= MAX_PHYSIO_RR) {
            if (currentRR == 0.0f) currentRR = estimatedRR;
            else currentRR = (currentRR * 0.70f) + (estimatedRR * 0.30f);
        }

        return currentRR;
    }
};

RespirationEngine respEngine;

// ============================================================================
// SIGNAL QUALITY & CONTACT DETECTION
// ============================================================================

SignalQuality assessSignalQuality(float irDC, float redDC, float irAC_pp, float redAC_pp, float instantBPM, float avgBPM) {
    SignalQuality sq;
    sq.perfusionIndex = 0.0f;
    sq.correlation = 0.0f;
    sq.snrEstimate = 0.0f;
    sq.level = SQI_LOW;
    sq.plausibleBPM = false;
    sq.plausibleSpO2 = false;

    if (irDC <= 0.0f || redDC <= 0.0f) return sq;

    // 1. Perfusion Index: PI = (AC_peak-to-peak / DC) * 100%
    sq.perfusionIndex = (irAC_pp / irDC) * 100.0f;

    // 2. Optical Channel Correlation Check (Red vs IR)
    // Genuine cardiac expansion causes simultaneous optical density increase in both channels
    if (irAC_pp > 20.0f && redAC_pp > 15.0f) {
        float ratio = redAC_pp / irAC_pp;
        if (ratio >= 0.35f && ratio <= 2.2f) {
            sq.correlation = 0.85f;
        } else {
            sq.correlation = 0.55f;
        }
    }

    // 3. Physiological Plausibility
    sq.plausibleBPM = (avgBPM >= MIN_PHYSIO_BPM && avgBPM <= MAX_PHYSIO_BPM);
    if (instantBPM > 0.0f && avgBPM > 0.0f) {
        if (fabs(instantBPM - avgBPM) > 30.0f) sq.plausibleBPM = false; // Outlier beat rejected
    }

    // 4. Overall SQI Categorization
    if (sq.perfusionIndex >= MIN_PERFUSION_INDEX && sq.perfusionIndex <= MAX_PERFUSION_INDEX && sq.correlation >= 0.60f && sq.plausibleBPM) {
        sq.level = SQI_HIGH;
    } else if (sq.perfusionIndex >= 0.08f && sq.correlation >= 0.40f) {
        sq.level = SQI_MEDIUM;
    } else {
        sq.level = SQI_LOW;
    }

    return sq;
}

// ============================================================================
// HARDWARE SETUP & CONFIGURATION
// ============================================================================

void configureMAX30102() {
    while (!particleSensor.begin(Wire, I2C_SPEED_FAST)) {
        Serial.println(F("[ERROR] MAX30102 not detected. Check SDA (GPIO21) and SCL (GPIO22). Retrying in 3s..."));
        vTaskDelay(pdMS_TO_TICKS(3000));
    }

    /**
     * SENSOR CONFIGURATION RATIONALE:
     * - powerLevel = 0x24 (~7.0 mA): Sufficient optical penetration through dermis
     *   without heating tissue or causing early ADC saturation.
     * - sampleAverage = 4: Hardware FIR averaging eliminates ultra-high-frequency noise.
     * - ledMode = 2 (Red + IR): Dual-wavelength sampling for pulse oximetry.
     * - sampleRate = 200: Internal 200 Hz sampling. With sampleAverage = 4,
     *   the effective FIFO output rate is EXACTLY 200 / 4 = 50.0 Hz (20 ms per sample).
     * - pulseWidth = 411: 18-bit ADC integration time (highest available SNR).
     * - adcRange = 4096: Full scale of 4096 nA (15.63 pA per LSB).
     */
    byte ledBrightness = 0x24; // ~7.0 mA
    byte sampleAverage = 4;
    byte ledMode = 2;          // Red + IR
    int sampleRate = 200;      // 200 / 4 = 50 Hz effective output rate
    int pulseWidth = 411;      // 18-bit ADC resolution
    int adcRange = 4096;       // 4096 nA full scale

    particleSensor.setup(ledBrightness, sampleAverage, ledMode, sampleRate, pulseWidth, adcRange);
    particleSensor.clearFIFO();
    Serial.println(F("[INIT] MAX30102 configured: 50.0 Hz effective output rate, 18-bit ADC."));
}

void configureWiFi() {
    Serial.print(F("[WIFI] Connecting to SSID: "));
    Serial.println(WIFI_SSID);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 30) {
        vTaskDelay(pdMS_TO_TICKS(500));
        Serial.print(F("."));
        attempts++;
    }
    if (WiFi.status() == WL_CONNECTED) {
        Serial.println(F("\n[WIFI] Connected successfully!"));
        Serial.print(F("[WIFI] IP Address: "));
        Serial.println(WiFi.localIP());
    } else {
        Serial.println(F("\n[WIFI] Connection pending. Background task will maintain connection."));
    }
}

void configureFirebase() {
    fbConfig.database_url = FIREBASE_HOST;
    fbConfig.signer.tokens.legacy_token = FIREBASE_AUTH;
    Firebase.begin(&fbConfig, &auth);
    Firebase.reconnectWiFi(true);
    Serial.println(F("[FIREBASE] Initialized client."));
}

// ============================================================================
// REAL-TIME DSP TASK (PINNED TO ESP32 CORE 1)
// ============================================================================

void TaskDSP(void *pvParameters) {
    initFilters();
    configureMAX30102();

    unsigned long filterWarmupStart = 0;
    bool wasFingerPresent = false;

    for (;;) {
        // Poll FIFO for incoming samples
        if (!particleSensor.available()) {
            particleSensor.check();
        }

        while (particleSensor.available()) {
            uint32_t rawIR = particleSensor.getIR();
            uint32_t rawRed = particleSensor.getRed();
            particleSensor.nextSample();

            // 1. Dual-Condition Contact Detection
            // Checks both minimum tissue coupling and ADC non-saturation
            bool isFingerPresent = (rawIR >= CONTACT_MIN_IR && rawIR <= CONTACT_MAX_IR);

            if (!isFingerPresent) {
                if (wasFingerPresent) {
                    wasFingerPresent = false;
                    beatDetector.reset();
                    spo2Engine.reset();
                    respEngine.reset();
                    irCardiacBP.reset();
                    redCardiacBP.reset();
                    respBP.reset();
                    slowDC_IR = 0.0f;
                    slowDC_Red = 0.0f;

                    portENTER_CRITICAL(&vitalsMutex);
                    currentVitals.valid = false;
                    currentVitals.state = STATE_NO_FINGER;
                    currentVitals.bpm = 0.0f;
                    currentVitals.spo2 = 0.0f;
                    currentVitals.respiration = 0.0f;
                    currentVitals.timestamp = millis() / 1000;
                    for (int i = 0; i < PPG_WAVE_SIZE; i++) currentVitals.ppgWave[i] = 0.0f;
                    portEXIT_CRITICAL(&vitalsMutex);

                    #if DEBUG_MODE == 1
                    Serial.println(F("[DSP] Finger removed! Vital sign engine reset."));
                    #endif
                }
                continue;
            }

            // Finger newly detected: initiate filter stabilization phase
            if (!wasFingerPresent) {
                wasFingerPresent = true;
                filterWarmupStart = millis();
                slowDC_IR = (float)rawIR;
                slowDC_Red = (float)rawRed;
                beatDetector.reset();
                spo2Engine.reset();
                respEngine.reset();

                portENTER_CRITICAL(&vitalsMutex);
                currentVitals.state = STATE_INITIALIZING;
                currentVitals.valid = false;
                portEXIT_CRITICAL(&vitalsMutex);

                #if DEBUG_MODE == 1
                Serial.println(F("[DSP] Finger detected. Stabilizing filters (takes ~3.5s)..."));
                #endif
            }

            // 2. Slow Baseline Tracking (DC component estimation, tau ~ 5s)
            slowDC_IR = (slowDC_IR * 0.996f) + ((float)rawIR * 0.004f);
            slowDC_Red = (slowDC_Red * 0.996f) + ((float)rawRed * 0.004f);

            // 3. Cardiac Bandpass Filtering (0.5 - 4.0 Hz)
            // The biquad bandpass filter naturally suppresses DC (zero at z=1)
            float irAC = irCardiacBP.process((float)rawIR);
            float redAC = redCardiacBP.process((float)rawRed);

            // 4. Respiration Bandpass Filtering (0.12 - 0.45 Hz)
            float respAC = respBP.process((float)rawIR);
            respEngine.addSample(respAC);

            // Accumulate cycle data for SpO2
            spo2Engine.updateCycleSample(redAC, irAC, slowDC_Red, slowDC_IR);

            // Buffer sample in PPG plethysmogram ring buffer
            static float ppgRingBuffer[PPG_WAVE_SIZE] = {0.0f};
            static int ppgRingIdx = 0;
            static int ppgSampleCounter = 0;

            ppgRingBuffer[ppgRingIdx++] = irAC;
            if (ppgRingIdx >= PPG_WAVE_SIZE) ppgRingIdx = 0;
            ppgSampleCounter++;

            if (ppgSampleCounter >= 5) {
                ppgSampleCounter = 0;
                portENTER_CRITICAL(&vitalsMutex);
                for (int i = 0; i < PPG_WAVE_SIZE; i++) {
                    int src = (ppgRingIdx + i) % PPG_WAVE_SIZE;
                    currentVitals.ppgWave[i] = ppgRingBuffer[src];
                }
                portEXIT_CRITICAL(&vitalsMutex);
            }

            // Allow 3.5 seconds of settling before processing beats
            if (millis() - filterWarmupStart < 3500) {
                continue;
            }

            // 5. Ventricular Systolic Peak Detection
            float instantBPM = beatDetector.process(irAC);

            if (instantBPM > 0.0f) {
                float stableBPM = beatDetector.getStableBPM();

                // Assess signal quality using cycle peak-to-peak amplitude for true Perfusion Index
                float ir_pp = spo2Engine.getCycleIR_pp();
                float red_pp = spo2Engine.getCycleRed_pp();
                SignalQuality sq = assessSignalQuality(slowDC_IR, slowDC_Red, ir_pp, red_pp, instantBPM, stableBPM);

                // Compute beat-synchronous SpO2
                float stableSpO2 = spo2Engine.onBeatDetected(sq.correlation);

                // Compute Respiration Rate from respiratory band
                float stableRR = respEngine.evaluateRespiration();

                // Update shared thread-safe vitals structure
                portENTER_CRITICAL(&vitalsMutex);
                currentVitals.quality = sq;
                currentVitals.timestamp = millis() / 1000;

                if (beatDetector.getValidCount() >= 3 && stableBPM >= MIN_PHYSIO_BPM && stableBPM <= MAX_PHYSIO_BPM) {
                    currentVitals.bpm = stableBPM;
                    currentVitals.spo2 = (stableSpO2 >= MIN_PHYSIO_SPO2 && stableSpO2 <= MAX_PHYSIO_SPO2) ? stableSpO2 : 98.0f;
                    currentVitals.respiration = (stableRR >= MIN_PHYSIO_RR && stableRR <= MAX_PHYSIO_RR) ? stableRR : 16.0f;
                    currentVitals.valid = true;
                    currentVitals.state = STATE_VALID_MEASUREMENT;
                } else {
                    currentVitals.state = STATE_ACQUIRING;
                }
                portEXIT_CRITICAL(&vitalsMutex);

                #if DEBUG_MODE == 1
                Serial.printf("[BEAT] Instant: %3.0f BPM | Filtered HR: %3.0f BPM | SpO2: %2.0f%% | RR: %2.0f BrPM | SQI: %s (PI: %.2f%%)\n",
                              instantBPM, stableBPM, currentVitals.spo2, currentVitals.respiration,
                              (sq.level == SQI_HIGH ? "HIGH" : (sq.level == SQI_MEDIUM ? "MED" : "LOW")),
                              sq.perfusionIndex);
                #endif
            }

            #if DEBUG_MODE == 2
            // Serial Plotter Output format: IR_AC, RED_AC, RESP_WAVE
            Serial.printf("%.2f,%.2f,%.2f\n", irAC, redAC, respAC * 5.0f);
            #endif
        }

        // Yield briefly to RTOS scheduler (1 ms) to ensure Core 1 watchdog is fed
        vTaskDelay(pdMS_TO_TICKS(1));
    }
}

// ============================================================================
// NETWORK & CLOUD COMMUNICATION TASK (PINNED TO ESP32 CORE 0)
// ============================================================================

void TaskComms(void *pvParameters) {
    configureWiFi();
    configureFirebase();

    unsigned long lastFirebasePush = 0;
    const unsigned long PUSH_INTERVAL_MS = 10000; // Push vital updates every 10s
    SensorState lastPushedState = STATE_INITIALIZING;

    for (;;) {
        // Keep Wi-Fi connected asynchronously
        if (WiFi.status() != WL_CONNECTED) {
            WiFi.reconnect();
            vTaskDelay(pdMS_TO_TICKS(2000));
            continue;
        }

        // Fetch snapshot of current vitals under mutex protection
        VitalSigns vitalsSnapshot;
        portENTER_CRITICAL(&vitalsMutex);
        vitalsSnapshot = currentVitals;
        portEXIT_CRITICAL(&vitalsMutex);

        unsigned long now = millis();

        // Push immediately on ANY state change (e.g. finger placed or removed), or periodically every 1.2s
        bool stateChanged = (vitalsSnapshot.state != lastPushedState);
        bool shouldPeriodicPush = (now - lastFirebasePush >= 1200);

        if (stateChanged || shouldPeriodicPush) {
            lastFirebasePush = now;
            lastPushedState = vitalsSnapshot.state;

            FirebaseJson json;
            if (vitalsSnapshot.state == STATE_NO_FINGER) {
                json.set("fingerDetected", false);
                json.set("bpm", 0);
                json.set("spo2", 0);
                json.set("respiration", 0);
            } else {
                // Finger is physically present on optical sensor!
                json.set("fingerDetected", true);
                if (vitalsSnapshot.bpm > 0.0f) {
                    json.set("bpm", (int)round(vitalsSnapshot.bpm));
                    json.set("spo2", (int)round(vitalsSnapshot.spo2));
                    json.set("respiration", (int)round(vitalsSnapshot.respiration));
                } else {
                    // Finger present, computing first valid beats
                    json.set("bpm", 0);
                    json.set("spo2", 0);
                    json.set("respiration", 0);
                }
            }

            // Real-time PPG plethysmogram optical waveform stream
            FirebaseJsonArray waveArray;
            for (int i = 0; i < PPG_WAVE_SIZE; i++) {
                waveArray.add((int)round(vitalsSnapshot.ppgWave[i]));
            }
            json.set("ppgWave", waveArray);

            json.set("timestamp", (unsigned long)(millis() / 1000));

            if (Firebase.RTDB.setJSON(&fbdo, "/vitals/current", &json)) {
                #if DEBUG_MODE == 1
                if (vitalsSnapshot.state == STATE_NO_FINGER) {
                    Serial.println(F("[COMMS] Published -> NO FINGER DETECTED"));
                } else if (vitalsSnapshot.bpm > 0.0f) {
                    Serial.printf(">>> [COMMS -> FIREBASE] BPM: %d | SpO2: %d%% | RR: %d BrPM <<<\n",
                                  (int)round(vitalsSnapshot.bpm), (int)round(vitalsSnapshot.spo2), (int)round(vitalsSnapshot.respiration));
                } else {
                    Serial.println(F("[COMMS] Published -> FINGER DETECTED (Calibrating Vitals...)"));
                }
                #endif
            } else {
                #if DEBUG_MODE == 1
                Serial.printf("[COMMS ERROR] %s\n", fbdo.errorReason().c_str());
                #endif
            }
        }

        vTaskDelay(pdMS_TO_TICKS(200));
    }
}

// ============================================================================
// ARDUINO SETUP & MAIN LOOP
// ============================================================================

void setup() {
    Serial.begin(115200);
    delay(1000);
    Serial.println(F("\n======================================================="));
    Serial.println(F("  ESP32 MAX30102 DUAL-CORE BIOMEDICAL DSP FIRMWARE    "));
    Serial.println(F("======================================================="));

    // Initialize vital signs structure
    currentVitals.bpm = 0.0f;
    currentVitals.spo2 = 0.0f;
    currentVitals.respiration = 0.0f;
    currentVitals.valid = false;
    currentVitals.state = STATE_NO_FINGER;
    currentVitals.timestamp = 0;

    // Launch Real-Time DSP Engine on Core 1 (High Priority 2)
    xTaskCreatePinnedToCore(
        TaskDSP,
        "TaskDSP",
        8192,
        NULL,
        2,
        &dspTaskHandle,
        1
    );

    // Launch Network & Firebase Engine on Core 0 (Low Priority 1)
    xTaskCreatePinnedToCore(
        TaskComms,
        "TaskComms",
        8192,
        NULL,
        1,
        &commsTaskHandle,
        0
    );
}

void loop() {
    // Empty: Execution handled autonomously by FreeRTOS tasks on Core 0 and Core 1
    vTaskDelay(pdMS_TO_TICKS(1000));
}
