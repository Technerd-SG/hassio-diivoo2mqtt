#include <WiFi.h>
#include <ctype.h>
#include "cmt2300a_defs.h"
#include <Preferences.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <ESPmDNS.h>

// ============================================================
// Firmware Verision
// ============================================================
constexpr char FW_VERSION[] = "0.1.10";
constexpr char FW_MODEL[]   = "tcp_gateway_WG03";

// ============================================================
// TCP
// ============================================================
constexpr uint16_t TCP_PORT = 8080;
WiFiServer server(TCP_PORT);
WiFiClient activeClient;

// ============================================================
// Globale Bridge-/Radio-States
// ============================================================
uint8_t currentTxChannel = 4; // default channel for init comms
uint8_t currentRxChannel = 0; // default channel for recieving from watering computer
volatile uint32_t packetInterruptCount = 0;

// NEU: Preamble Profile
enum TxProfile : uint8_t {
  TX_PROFILE_SHORT = 0,
  TX_PROFILE_LONG  = 1
};
uint8_t currentTxProfile = TX_PROFILE_SHORT;

// ============================================================
// Hardware-Konfiguration
// ============================================================
constexpr uint8_t PIN_SCLK      = 27;
constexpr uint8_t PIN_SDIO      = 19;
constexpr uint8_t PIN_CSB       = 25;
constexpr uint8_t PIN_FCSB      = 26;
constexpr uint8_t PIN_VCC_EN    = 21;
constexpr uint8_t PIN_INTERRUPT = 18;
constexpr uint8_t PIN_LED = 14;
constexpr uint8_t PIN_BUTTON = 13;

// ============================================================
// Hardware UI (LED & Button)
// ============================================================

// LED State Machine
enum SystemState {
  STATE_UNCONFIGURED,
  STATE_CONNECTING,
  STATE_CONNECTED
};
SystemState currentSystemState = STATE_CONNECTING; // Startzustand
uint32_t lastLedToggleMs = 0;
bool ledState = HIGH; // HIGH = aus (Active Low)
bool tcpLedOverride = false; // True, wenn per TCP gesteuert

// Button Debouncing (Entprellen)
uint32_t lastDebounceTime = 0;
bool lastRawButtonState = HIGH;
bool lastButtonState = HIGH; // HIGH = ungedrückt wegen Pullup
constexpr uint32_t DEBOUNCE_DELAY_MS = 50;

// ============================================================
// Timing
// ============================================================
constexpr uint8_t  T_CLK_HIGH_US       = 3;
constexpr uint8_t  T_CLK_LOW_US        = 3;
constexpr uint8_t  T_CS_SETUP_US       = 2;
constexpr uint8_t  T_INTER_BLOCK_US    = 10;
constexpr uint8_t  T_FIFO_PAUSE_US     = 20;
constexpr uint16_t T_TX_FIFO_CLEAR_US  = 500;
constexpr uint8_t  T_POST_TX_DELAY_MS  = 10;
constexpr uint8_t  T_POST_SLEEP_MS     = 40;
constexpr uint8_t  T_POST_STBY_MS      = 1;
constexpr uint16_t TX_TIMEOUT_MS       = 150;
constexpr uint8_t  TX_POLL_DELAY_MS    = 17;

// ============================================================
// Paket-/TCP-Konstanten
// ============================================================
constexpr uint8_t PACKET_LENGTH = 32;
constexpr size_t  TCP_LINE_BUFFER_SIZE = 256;

// FIFO_CTL Werte, bewusst benannt
constexpr uint8_t FIFO_CTL_RX_SPI = 0x00;
constexpr uint8_t FIFO_CTL_TX_SPI = 0x05;

// RX/TX-Command-Buffer
char inputBuffer[TCP_LINE_BUFFER_SIZE];
size_t inputBufferLen = 0;

Preferences prefs;
WebServer configServer(80);

bool configPortalActive = false;
bool tcpServerStarted = false;
bool rebootScheduled = false;
uint32_t rebootAtMs = 0;

bool portalStartScheduled = false;
uint32_t portalStartAtMs = 0;
constexpr uint32_t PORTAL_START_DELAY_MS = 700;

constexpr uint32_t WIFI_CONNECT_TIMEOUT_MS = 15000;
constexpr char PREF_NAMESPACE[] = "netcfg";
constexpr char PREF_KEY_SSID[] = "ssid";
constexpr char PREF_KEY_PASS[] = "pass";

char serialInputBuffer[TCP_LINE_BUFFER_SIZE];
size_t serialInputLen = 0;

// Forward Declaration aus sequences.ino
void executeInitSequence();

// ============================================================
// Hilfsfunktionen: Logging / Client
// ============================================================
bool hasActiveClient() {
  return activeClient && activeClient.connected();
}

void sendLineToClient(const char* line) {
  if (hasActiveClient()) {
    activeClient.println(line);
  }
}

void sendLineToClientAndSerial(const char* line) {
  sendLineToClient(line);
  Serial.println(line);
}

// ============================================================
// Low-Level SPI (Bit-Banging)
// ============================================================
void spiSendByte(uint8_t data) {
  for (int8_t i = 7; i >= 0; i--) {
    digitalWrite(PIN_SDIO, (data >> i) & 0x01);
    digitalWrite(PIN_SCLK, HIGH);
    delayMicroseconds(T_CLK_HIGH_US);
    digitalWrite(PIN_SCLK, LOW);
    delayMicroseconds(T_CLK_LOW_US);
  }
}

uint8_t spiReceiveByte() {
  uint8_t data = 0;
  for (int8_t i = 7; i >= 0; i--) {
    digitalWrite(PIN_SCLK, HIGH);
    delayMicroseconds(T_CLK_HIGH_US);

    if (digitalRead(PIN_SDIO)) {
      data |= (1 << i);
    }

    digitalWrite(PIN_SCLK, LOW);
    delayMicroseconds(T_CLK_LOW_US);
  }
  return data;
}

// ============================================================
// Registerzugriff
// ============================================================
void writeRegister(uint8_t addr, uint8_t data) {
  digitalWrite(PIN_CSB, LOW);
  delayMicroseconds(T_CS_SETUP_US);

  spiSendByte(addr & 0x7F); // WRITE
  spiSendByte(data);

  digitalWrite(PIN_CSB, HIGH);
  delayMicroseconds(T_INTER_BLOCK_US);
}

uint8_t readRegister(uint8_t addr) {
  digitalWrite(PIN_CSB, LOW);
  delayMicroseconds(T_CS_SETUP_US);

  spiSendByte(addr | 0x80); // READ

  pinMode(PIN_SDIO, INPUT_PULLUP);
  uint8_t result = spiReceiveByte();

  pinMode(PIN_SDIO, OUTPUT);
  digitalWrite(PIN_SDIO, HIGH);

  digitalWrite(PIN_CSB, HIGH);
  delayMicroseconds(T_INTER_BLOCK_US);

  return result;
}

// ============================================================
// FIFO-Zugriff
// ============================================================
void readFifo(uint8_t* buffer, uint8_t len) {
  digitalWrite(PIN_SCLK, LOW);
  pinMode(PIN_SDIO, INPUT_PULLUP);

  for (uint8_t i = 0; i < len; i++) {
    digitalWrite(PIN_FCSB, LOW);
    delayMicroseconds(T_CS_SETUP_US);

    buffer[i] = spiReceiveByte();

    digitalWrite(PIN_FCSB, HIGH);
    delayMicroseconds(T_FIFO_PAUSE_US);
  }

  pinMode(PIN_SDIO, OUTPUT);
  digitalWrite(PIN_SDIO, HIGH);
}

void writeFifo(const uint8_t* buffer, uint8_t len) {
  pinMode(PIN_SDIO, OUTPUT);
  digitalWrite(PIN_SCLK, LOW);

  for (uint8_t i = 0; i < len; i++) {
    digitalWrite(PIN_FCSB, LOW);
    delayMicroseconds(T_CS_SETUP_US);

    spiSendByte(buffer[i]);

    digitalWrite(PIN_FCSB, HIGH);
    delayMicroseconds(T_FIFO_PAUSE_US);
  }
}

// ============================================================
// Radio-Helfer
// ============================================================
inline void cmtGoStandby() {
  writeRegister(CMT2300A_CUS_MODE_CTL, CMT2300A_GO_STBY);
  delayMicroseconds(100);
}

inline void cmtGoRx() {
  writeRegister(CMT2300A_CUS_MODE_CTL, CMT2300A_GO_RX);
}

inline void cmtGoTx() {
  writeRegister(CMT2300A_CUS_MODE_CTL, CMT2300A_GO_TX);
}

inline void cmtGoSleep() {
  writeRegister(CMT2300A_CUS_MODE_CTL, CMT2300A_GO_SLEEP);
}

inline void cmtSelectChannel(uint8_t channel) {
  writeRegister(CMT2300A_CUS_FREQ_CHNL, channel);
}

inline void cmtFlushRxFifo() {
  writeRegister(CMT2300A_CUS_FIFO_CLR, CMT2300A_MASK_FIFO_CLR_RX);
}

inline void cmtFlushTxFifo() {
  writeRegister(CMT2300A_CUS_FIFO_CLR, CMT2300A_MASK_FIFO_CLR_TX);
}

inline void cmtSetFifoRxMode() {
  writeRegister(CMT2300A_CUS_FIFO_CTL, FIFO_CTL_RX_SPI);
}

inline void cmtSetFifoTxMode() {
  writeRegister(CMT2300A_CUS_FIFO_CTL, FIFO_CTL_TX_SPI);
}

// Diese "Dummy-Reads" bewusst beibehalten, weil sie Teil der
// funktionierenden Original-Sequenz sind.
inline void cmtPrimeStatusReads() {
  (void)readRegister(CMT2300A_CUS_INT1_CTL);
  (void)readRegister(CMT2300A_CUS_INT_FLAG);
  (void)readRegister(CMT2300A_CUS_INT_CLR1);
}

inline void cmtPrimeFifoReads() {
  (void)readRegister(CMT2300A_CUS_FIFO_CTL);
  (void)readRegister(CMT2300A_CUS_FIFO_FLAG);
}

inline void cmtClearInterruptsRaw(uint8_t intClr1, uint8_t intClr2) {
  writeRegister(CMT2300A_CUS_INT_CLR1, intClr1);
  writeRegister(CMT2300A_CUS_INT_CLR2, intClr2);
}

// Wird beim TUNE sofort ausgeführt, möglichst nah an deinem Original
void retuneAndEnterRx(uint8_t rxChannel) {
  cmtGoStandby();
  cmtSelectChannel(rxChannel);

  writeRegister(CMT2300A_CUS_INT_CLR1, 0xFF);
  writeRegister(CMT2300A_CUS_INT_CLR2, 0xFF);
  cmtSetFifoRxMode();
  cmtFlushRxFifo();
  cmtGoRx();
}

// RX-Restore nach TX, bewusst nahe an deiner funktionierenden Sequenz
void restoreRxAfterTx() {
  cmtPrimeStatusReads();
  cmtClearInterruptsRaw(0x00, 0x00);

  cmtGoStandby();
  cmtSelectChannel(currentRxChannel);

  cmtPrimeStatusReads();
  cmtClearInterruptsRaw(0x00, 0x00);

  cmtPrimeFifoReads();
  cmtSetFifoRxMode();
  cmtFlushRxFifo();
  cmtGoRx();
}

// ============================================================
// TX-Sequenz
// ============================================================
bool waitForTxDone() {
  const uint32_t startWait = millis();
  while ((millis() - startWait) < TX_TIMEOUT_MS) {
    delay(TX_POLL_DELAY_MS);

    // bewusst wie in deinem Original über 0x6A geprüft
    if (readRegister(CMT2300A_CUS_INT_CLR1) & CMT2300A_MASK_TX_DONE_FLG) {
      return true;
    }
  }
  return false;
}

bool sendPacket(const uint8_t* payload, uint8_t len) {
  // 1. Auf TX-Kanal wechseln / TX vorbereiten
  cmtGoStandby();
  
  // NEU: Preamble anwenden, bevor wir senden!
  applyPreambleProfileIfNeeded(currentTxProfile);
  
  cmtSelectChannel(currentTxChannel);

  cmtPrimeStatusReads();
  cmtClearInterruptsRaw(0x00, 0x00);

  (void)readRegister(CMT2300A_CUS_FIFO_CTL);
  cmtSetFifoTxMode();

  (void)readRegister(CMT2300A_CUS_FIFO_FLAG);
  cmtFlushTxFifo();
  delayMicroseconds(T_TX_FIFO_CLEAR_US);

  // 2. Payload laden
  writeFifo(payload, len);

  // 3. GO_TX
  cmtGoTx();

  // 4. Auf TX_DONE warten
  const bool txSuccess = waitForTxDone();

  // 5. Cleanup / Kalibrier-Sequenz wie im Original
  delay(T_POST_TX_DELAY_MS);
  cmtPrimeStatusReads();
  cmtClearInterruptsRaw(CMT2300A_MASK_TX_DONE_CLR, 0x00);

  cmtGoSleep();
  delay(T_POST_SLEEP_MS);

  cmtGoStandby();
  delay(T_POST_STBY_MS);

  // 6. Zurück auf RX-Kanal
  restoreRxAfterTx();

  return txSuccess;
}

// ============================================================
// Hex-/TCP-Helfer
// ============================================================
uint8_t hexCharToNibble(char c) {
  if (c >= '0' && c <= '9') return static_cast<uint8_t>(c - '0');
  if (c >= 'A' && c <= 'F') return static_cast<uint8_t>(c - 'A' + 10);
  if (c >= 'a' && c <= 'f') return static_cast<uint8_t>(c - 'a' + 10);
  return 0xFF;
}

bool isValidHexString(const char* s) {
  if (s == nullptr || *s == '\0') return false;

  while (*s) {
    if (hexCharToNibble(*s) == 0xFF) {
      return false;
    }
    ++s;
  }
  return true;
}

bool hexStringToBytes(const char* hexString, uint8_t* byteArray, uint8_t length) {
  for (uint8_t i = 0; i < length; i++) {
    const uint8_t hi = hexCharToNibble(hexString[i * 2]);
    const uint8_t lo = hexCharToNibble(hexString[i * 2 + 1]);

    if (hi == 0xFF || lo == 0xFF) {
      return false;
    }

    byteArray[i] = static_cast<uint8_t>((hi << 4) | lo);
  }
  return true;
}

void bytesToHexString(const uint8_t* byteArray, uint8_t length, char* outBuffer) {
  static const char HEX_CHARS[] = "0123456789ABCDEF";

  for (uint8_t i = 0; i < length; i++) {
    outBuffer[i * 2]     = HEX_CHARS[(byteArray[i] >> 4) & 0x0F];
    outBuffer[i * 2 + 1] = HEX_CHARS[byteArray[i] & 0x0F];
  }
  outBuffer[length * 2] = '\0';
}

void trimInPlace(char* str) {
  if (str == nullptr || *str == '\0') return;

  char* start = str;
  while (*start && isspace(static_cast<unsigned char>(*start))) {
    ++start;
  }

  if (start != str) {
    memmove(str, start, strlen(start) + 1);
  }

  size_t len = strlen(str);
  while (len > 0 && isspace(static_cast<unsigned char>(str[len - 1]))) {
    str[len - 1] = '\0';
    --len;
  }
}

// ============================================================
// Kommandoverarbeitung
// ============================================================
void handleTuneCommand(char* args) {
  // Erwartetes Format: <tx>:<rx> oder <tx>:<rx>:<profile>
  // args zeigt auf den String NACH "TUNE:"
  
  char* txStr = strtok(args, ":");
  char* rxStr = strtok(NULL, ":");
  char* profStr = strtok(NULL, ":");

  if (txStr != NULL && rxStr != NULL) {
    uint8_t newTx = (uint8_t) atoi(txStr);
    uint8_t newRx = (uint8_t) atoi(rxStr);
    uint8_t newProfile = TX_PROFILE_SHORT;

    if (profStr != NULL) {
      newProfile = parseTxProfileToken(profStr);
    }

    bool txChanged = (currentTxChannel != newTx);
    bool rxChanged = (currentRxChannel != newRx);
    bool profileChanged = (currentTxProfile != newProfile);

    if (!txChanged && !rxChanged && !profileChanged) {
      Serial.printf("[RADIO] Unverändert: TX=%u RX=%u PROFILE=%s\n", currentTxChannel, currentRxChannel, txProfileToString(currentTxProfile));
    } else {
      // 1. Immer erst Standby für Settings
      cmtGoStandby();
      delayMicroseconds(100);

      // 2. Profile anwenden falls nötig
      if (profileChanged) {
        applyPreambleProfileIfNeeded(newProfile);
      }

      // 3. Globals aktualisieren
      currentTxChannel = newTx;
      currentRxChannel = newRx;

      // 4. Zurück auf RX-Kanal (die V2-Logik dafür)
      restoreRxAfterTx(); // Deine V2-Funktion, die enterRxListenModeOnCurrentChannel ersetzt

      Serial.printf("[RADIO] Konfig aktualisiert: TX=%u RX=%u PROFILE=%s\n", currentTxChannel, currentRxChannel, txProfileToString(currentTxProfile));
    }

    sendLineToClient("ACK:TUNED");
  } else {
    sendLineToClient("ERR:TUNE_FORMAT");
  }
}

void handleTxCommand(const char* hexPayload) {
  if (hexPayload == nullptr || *hexPayload == '\0') {
    sendLineToClientAndSerial("ERR:EMPTY_TX");
    return;
  }

  const size_t hexLen = strlen(hexPayload);
  if ((hexLen % 2) != 0) {
    sendLineToClientAndSerial("ERR:BAD_HEX_LENGTH");
    return;
  }

  if (!isValidHexString(hexPayload)) {
    sendLineToClientAndSerial("ERR:BAD_HEX");
    return;
  }

  const size_t packetLen = hexLen / 2;
  if (packetLen == 0 || packetLen > PACKET_LENGTH) {
    sendLineToClientAndSerial("ERR:BAD_PACKET_LENGTH");
    return;
  }

  uint8_t txBuffer[PACKET_LENGTH] = {0};
  if (!hexStringToBytes(hexPayload, txBuffer, static_cast<uint8_t>(packetLen))) {
    sendLineToClientAndSerial("ERR:HEX_PARSE");
    return;
  }

  const bool success = sendPacket(txBuffer, static_cast<uint8_t>(packetLen));
  sendLineToClient(success ? "ACK:TX_OK" : "ERR:TX_FAIL");
  Serial.println(success ? "TX erfolgreich" : "TX fehlgeschlagen");
}

bool loadStoredWiFi(char* ssidOut, size_t ssidOutLen, char* passOut, size_t passOutLen) {
  prefs.begin(PREF_NAMESPACE, true);

  String ssid = prefs.getString(PREF_KEY_SSID, "");
  String pass = prefs.getString(PREF_KEY_PASS, "");

  prefs.end();

  if (ssid.isEmpty()) {
    ssidOut[0] = '\0';
    passOut[0] = '\0';
    return false;
  }

  ssid.toCharArray(ssidOut, ssidOutLen);
  pass.toCharArray(passOut, passOutLen);
  return true;
}

void saveStoredWiFi(const char* ssid, const char* pass) {
  prefs.begin(PREF_NAMESPACE, false);
  prefs.putString(PREF_KEY_SSID, ssid);
  prefs.putString(PREF_KEY_PASS, pass);
  prefs.end();

  Serial.printf("[WIFI] WLAN-Daten gespeichert. SSID='%s'\n", ssid);
}

void clearStoredWiFi() {
  prefs.begin(PREF_NAMESPACE, false);
  prefs.remove(PREF_KEY_SSID);
  prefs.remove(PREF_KEY_PASS);
  prefs.end();
}

void ensureTcpServerStarted() {
  if (!tcpServerStarted) {
    server.begin();
    tcpServerStarted = true;
    Serial.printf("TCP Server gestartet auf Port %u\n", TCP_PORT);
  }
}

void stopConfigPortal() {
  if (!configPortalActive) return;

  configServer.stop();
  WiFi.softAPdisconnect(true);
  configPortalActive = false;

  Serial.println("Config-Portal gestoppt.");
}

String makeSetupApSsid() {
  uint32_t suffix = static_cast<uint32_t>(ESP.getEfuseMac() & 0xFFFF);
  char buf[32];
  snprintf(buf, sizeof(buf), "Diivoo-Setup-%04X", suffix);
  return String(buf);
}

void startConfigPortal() {
  tcpLedOverride = false;
  currentSystemState = STATE_UNCONFIGURED;
  if (configPortalActive) return;

  WiFi.disconnect(false, false);
  WiFi.mode(WIFI_AP);

  const String apSsid = makeSetupApSsid();
  WiFi.softAP(apSsid.c_str());

  IPAddress ip = WiFi.softAPIP();

  configServer.on("/", HTTP_GET, []() {
    String html;
    html.reserve(1500);

    html += F(
      "<!doctype html><html><head>"
      "<meta charset='utf-8'>"
      "<meta name='viewport' content='width=device-width,initial-scale=1'>"
      "<title>Diivoo Gateway Setup</title>"
      "<style>"
      "body{font-family:Arial,sans-serif;max-width:520px;margin:40px auto;padding:0 16px;}"
      "input{width:100%;padding:10px;margin:6px 0 14px 0;box-sizing:border-box;}"
      "button{padding:10px 16px;font-size:16px;}"
      ".muted{color:#666;font-size:14px;}"
      "</style></head><body>"
      "<h2>Diivoo Gateway WLAN Setup</h2>"
      "<p>Bitte SSID und Passwort eingeben.</p>"
      "<form method='POST' action='/save'>"
      "<label>SSID</label>"
      "<input name='ssid' maxlength='32' required>"
      "<label>Passwort</label>"
      "<input name='pass' type='password' maxlength='64'>"
      "<button type='submit'>Speichern</button>"
      "</form>"
      "<p class='muted'>Nach dem Speichern startet der ESP automatisch neu.</p>"
      "</body></html>"
    );

    configServer.send(200, "text/html; charset=utf-8", html);
  });

  configServer.on("/save", HTTP_POST, []() {
    if (!configServer.hasArg("ssid")) {
      Serial.println("[PORTAL] Speichern fehlgeschlagen: SSID fehlt.");
      configServer.send(400, "text/plain", "SSID fehlt");
      return;
    }

    const String ssid = configServer.arg("ssid");
    const String pass = configServer.arg("pass");

    Serial.printf("[PORTAL] Neue WLAN-Daten erhalten. SSID='%s'\n", ssid.c_str());

    saveStoredWiFi(ssid.c_str(), pass.c_str());

    configServer.send(
      200,
      "text/html; charset=utf-8",
      "<html><body><h3>Gespeichert.</h3><p>Der ESP startet jetzt neu.</p></body></html>"
    );

    Serial.println("[PORTAL] WLAN-Daten gespeichert. Neustart geplant.");

    rebootScheduled = true;
    rebootAtMs = millis() + 1500;
  });

  configServer.on("/clear", HTTP_GET, []() {
    clearStoredWiFi();
    configServer.send(
      200,
      "text/html; charset=utf-8",
      "<html><body><h3>WLAN-Daten gelöscht.</h3><p>Der ESP startet jetzt neu.</p></body></html>"
    );

    rebootScheduled = true;
    rebootAtMs = millis() + 1500;
  });

  configServer.onNotFound([]() {
    configServer.sendHeader("Location", "/", true);
    configServer.send(302, "text/plain", "");
  });

  configServer.begin();
  configPortalActive = true;

  Serial.println("[PORTAL] WLAN-Konfigurationsportal aktiv.");
  Serial.printf("[PORTAL] AP-SSID: %s\n", apSsid.c_str());
  Serial.printf("[PORTAL] Portal erreichbar unter: http://%s/\n", ip.toString().c_str());
  Serial.println("[PORTAL] Benutzer kann jetzt SSID und Passwort eingeben.");
}

bool connectToStoredWiFi(uint32_t timeoutMs = WIFI_CONNECT_TIMEOUT_MS) {
  tcpLedOverride = false;
  currentSystemState = STATE_CONNECTING;
  char ssid[33] = {0};
  char pass[65] = {0};

  Serial.println("[WIFI] Prüfe gespeicherte WLAN-Konfiguration ...");

  if (!loadStoredWiFi(ssid, sizeof(ssid), pass, sizeof(pass))) {
    Serial.println("[WIFI] Keine gespeicherten WLAN-Daten gefunden.");
    Serial.println("[WIFI] Starte Konfigurations-Hotspot.");
    return false;
  }

  Serial.printf("[WIFI] Gespeicherte SSID gefunden: '%s'\n", ssid);

  stopConfigPortal();

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, pass);

  Serial.printf("[WIFI] Verbinde mit WLAN '%s' ...\n", ssid);

  const uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - start) < timeoutMs) {
    handleHardwareUI();
    delay(100);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[WIFI] Verbunden. IP: %s\n", WiFi.localIP().toString().c_str());
    
    // mDNS Hostname generieren (diivoo-gw-<MAC>)
    uint8_t mac[6];
    WiFi.macAddress(mac);
    char mdnsName[32];
    snprintf(mdnsName, sizeof(mdnsName), "diivoo-gw-%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    
    if (MDNS.begin(mdnsName)) {
      Serial.printf("[mDNS] Responder gestartet: %s.local\n", mdnsName);
      MDNS.addService("diivoo", "tcp", TCP_PORT);
    } else {
      Serial.println("[mDNS] Fehler beim Starten des mDNS Responders!");
    }

    currentSystemState = STATE_CONNECTED;
    ensureTcpServerStarted();
    return true;
  }

  Serial.printf("[WIFI] Verbindung zu '%s' fehlgeschlagen.\n", ssid);
  Serial.println("[WIFI] Starte Konfigurations-Hotspot.");
  return false;
}

bool performOtaUpdate(const char* url) {
  if (url == nullptr || *url == '\0') {
    Serial.println("[OTA] Fehler: leere URL.");
    sendLineToClientAndSerial("ERR:OTA_EMPTY_URL");
    return false;
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[OTA] Fehler: kein WLAN verbunden.");
    sendLineToClientAndSerial("ERR:OTA_NO_WIFI");
    return false;
  }

  Serial.printf("[OTA] Starte OTA-Update von: %s\n", url);
  sendLineToClientAndSerial("ACK:OTA_START");

  Serial.println("[OTA] Setze RF-Chip in Standby.");
  cmtGoStandby();

  // Wichtig: automatischen Reboot deaktivieren,
  // damit wir ACK:OTA_OK noch sicher senden können.
  httpUpdate.rebootOnUpdate(false);

  NetworkClient otaClient;
  t_httpUpdate_return ret = httpUpdate.update(otaClient, url);

  switch (ret) {
    case HTTP_UPDATE_FAILED: {
      int err = httpUpdate.getLastError();
      String reason = httpUpdate.getLastErrorString();
      Serial.printf("[OTA] Fehlgeschlagen. Code=%d, Grund=%s\n", err, reason.c_str());
      sendLineToClientAndSerial("ERR:OTA_FAILED");
      restoreRxAfterTx();
      return false;
    }

    case HTTP_UPDATE_NO_UPDATES:
      Serial.println("[OTA] Keine neuere Firmware verfügbar.");
      sendLineToClientAndSerial("ACK:OTA_NO_UPDATES");
      restoreRxAfterTx();
      return false;

    case HTTP_UPDATE_OK:
      Serial.println("[OTA] Update erfolgreich geschrieben. Sende ACK und starte neu.");
      sendLineToClientAndSerial("ACK:OTA_OK");
      Serial.flush();
      delay(1000);
      ESP.restart();
      return true;
  }

  Serial.println("[OTA] Unerwarteter Zustand.");
  sendLineToClientAndSerial("ERR:OTA_UNKNOWN_STATE");
  restoreRxAfterTx();
  return false;
}

void serviceConfigPortal() {
  if (configPortalActive) {
    configServer.handleClient();
  }

  if (rebootScheduled && millis() >= rebootAtMs) {
    Serial.println("Neustart...");
    delay(100);
    ESP.restart();
  }
}

void serviceDeferredActions() {
  if (portalStartScheduled && millis() >= portalStartAtMs) {
    portalStartScheduled = false;

    Serial.println("[PORTAL] Wechsle jetzt in den Konfigurations-Hotspot.");
    Serial.println("[PORTAL] Aktuelle WLAN-Verbindung wird getrennt.");

    startConfigPortal();
  }
}

void serviceSerialInput() {
  while (Serial.available()) {
    const char c = static_cast<char>(Serial.read());

    if (c == '\r') continue;

    if (c == '\n') {
      serialInputBuffer[serialInputLen] = '\0';
      processCommand(serialInputBuffer);
      serialInputLen = 0;
      serialInputBuffer[0] = '\0';
      continue;
    }

    if (serialInputLen < (TCP_LINE_BUFFER_SIZE - 1)) {
      serialInputBuffer[serialInputLen++] = c;
    } else {
      serialInputLen = 0;
      serialInputBuffer[0] = '\0';
      Serial.println("ERR:SERIAL_LINE_TOO_LONG");
    }
  }
}

void handleOtaCommand(char* url) {
  trimInPlace(url);
  performOtaUpdate(url);
}

void handlePingUrlCommand(char* url) {
  trimInPlace(url);
  HTTPClient http;
  http.begin(url);
  http.setTimeout(3000);
  int code = http.GET();
  http.end();
  if (code > 0) {
    sendLineToClientAndSerial("ACK:PING_OK");
  } else {
    sendLineToClientAndSerial("ERR:PING_UNREACHABLE");
  }
}

void processCommand(char* cmd) {
  trimInPlace(cmd);

  if (*cmd == '\0') {
    return;
  }

  if (strncmp(cmd, "TUNE:", 5) == 0) {
    handleTuneCommand(cmd + 5);
    return;
  }

  if (strncmp(cmd, "TX:", 3) == 0) {
    handleTxCommand(cmd + 3);
    return;
  }

  if (strncmp(cmd, "OTA:", 4) == 0) {
    handleOtaCommand(cmd + 4);
    return;
  }

  if (strncmp(cmd, "PING_URL:", 9) == 0) {
    handlePingUrlCommand(cmd + 9);
    return;
  }

  if (strcmp(cmd, "PORTAL") == 0) {
    Serial.println("[PORTAL] Portal-Start angefordert.");
    sendLineToClientAndSerial("ACK:PORTAL_STARTING");

    portalStartScheduled = true;
    portalStartAtMs = millis() + PORTAL_START_DELAY_MS;
    return;
  }

  if (strcmp(cmd, "CLEARWIFI") == 0) {
    clearStoredWiFi();
    sendLineToClientAndSerial("ACK:WIFI_CLEARED");
    return;
  }

  if (strcmp(cmd, "WIFI") == 0) {
    if (WiFi.status() == WL_CONNECTED) {
      Serial.printf("WLAN verbunden. IP: %s\n", WiFi.localIP().toString().c_str());
      sendLineToClient("ACK:WIFI_OK");
    } else {
      Serial.println("WLAN nicht verbunden.");
      sendLineToClient("ERR:WIFI_DOWN");
    }
    return;
  }

  if (strcmp(cmd, "VERSION") == 0) {
    reportVersion();
    return;
  }

  if (strncmp(cmd, "LED:", 4) == 0) {
    if (strcmp(cmd + 4, "ON") == 0) {
      tcpLedOverride = true; // State-Machine deaktivieren
      digitalWrite(PIN_LED, LOW); // LOW = an
      sendLineToClientAndSerial("ACK:LED_ON");
    } else if (strcmp(cmd + 4, "OFF") == 0) {
      tcpLedOverride = true; // State-Machine deaktivieren
      digitalWrite(PIN_LED, HIGH); // HIGH = aus
      sendLineToClientAndSerial("ACK:LED_OFF");
    }
    return;
  }

  sendLineToClientAndSerial("ERR:UNKNOWN_CMD");
}

// ============================================================
// RX-Handling
// ============================================================
bool takePendingPacketInterrupt() {
  bool hasWork = false;

  noInterrupts();
  if (packetInterruptCount > 0) {
    packetInterruptCount--;
    hasWork = true;
  }
  interrupts();

  return hasWork;
}

void handleReceivedPacket() {
  const uint8_t intFlags = readRegister(CMT2300A_CUS_INT_FLAG);
  const uint8_t rssiCode = readRegister(CMT2300A_CUS_RSSI_CODE);
  const int8_t  rssiDbm  = static_cast<int8_t>(readRegister(CMT2300A_CUS_RSSI_DBM) - 128);

  cmtGoStandby();

  uint8_t payload[PACKET_LENGTH] = {0};
  readFifo(payload, PACKET_LENGTH);

  char payloadHex[(PACKET_LENGTH * 2) + 1];
  bytesToHexString(payload, PACKET_LENGTH, payloadHex);

  char rxLine[120];
  snprintf(
    rxLine,
    sizeof(rxLine),
    "RX:%02X:%02X:%d:%s",
    intFlags,
    rssiCode,
    rssiDbm,
    payloadHex
  );
  sendLineToClientAndSerial(rxLine);

  // Cleanup wie im Original
  writeRegister(CMT2300A_CUS_INT_CLR1, 0x00);
  writeRegister(CMT2300A_CUS_INT_CLR2, intFlags);
  cmtFlushRxFifo();
  cmtGoRx();
}

// ============================================================
// Client-Handling
// ============================================================
void serviceClientLifecycle() {
  if (activeClient && !activeClient.connected()) {
    Serial.println("NodeJS getrennt.");
    activeClient.stop();
    activeClient = WiFiClient();
    inputBufferLen = 0;
    inputBuffer[0] = '\0';
  }

  if (!hasActiveClient()) {
    WiFiClient newClient = server.available();
    if (newClient) {
      activeClient = newClient;
      Serial.println("NodeJS verbunden!");
    }
  }
}

void serviceClientInput() {
  if (!hasActiveClient()) return;

  while (activeClient.available()) {
    const char c = static_cast<char>(activeClient.read());

    if (c == '\r') {
      continue;
    }

    if (c == '\n') {
      inputBuffer[inputBufferLen] = '\0';
      processCommand(inputBuffer);
      inputBufferLen = 0;
      inputBuffer[0] = '\0';
      continue;
    }

    if (inputBufferLen < (TCP_LINE_BUFFER_SIZE - 1)) {
      inputBuffer[inputBufferLen++] = c;
    } else {
      inputBufferLen = 0;
      inputBuffer[0] = '\0';
      sendLineToClientAndSerial("ERR:LINE_TOO_LONG");
    }
  }
}

void reportVersion() {
  char line[96];
  snprintf(line, sizeof(line), "VERSION:%s:%s", FW_MODEL, FW_VERSION);

  if (hasActiveClient()) {
    activeClient.println(line);
  }
  Serial.println(line);
}

// ============================================================
// Preamble & Profile Management
// ============================================================
const char* txProfileToString(uint8_t profile) {
  switch (profile) {
    case TX_PROFILE_LONG:  return "long";
    case TX_PROFILE_SHORT:
    default:               return "short";
  }
}

uint8_t parseTxProfileToken(const char* token) {
  if (token == nullptr) return TX_PROFILE_SHORT;
  
  // Kopie für toLowerCase machen
  String t = String(token);
  t.trim();
  t.toLowerCase();

  if (t == "long" || t == "l" || t == "1") {
    return TX_PROFILE_LONG;
  }
  return TX_PROFILE_SHORT;
}

void applyShortPreambleRegisters() {
  // TX_PREAM_SIZE = 0x0028 = 40 units
  writeRegister(0x39, 0x28); // CUS_PKT2: TX_PREAM_SIZE[7:0]
  writeRegister(0x3A, 0x00); // CUS_PKT3: TX_PREAM_SIZE[15:8]
  writeRegister(0x3B, 0xAA); // CUS_PKT4: PREAM_VALUE
  Serial.println("[RADIO] Short-Preamble Register gesetzt (40 units)");
}

void applyLongPreambleRegisters() {
  // TX_PREAM_SIZE = 0x012C = 300 units
  writeRegister(0x39, 0x2C); // CUS_PKT2: TX_PREAM_SIZE[7:0]
  writeRegister(0x3A, 0x01); // CUS_PKT3: TX_PREAM_SIZE[15:8]
  writeRegister(0x3B, 0xAA); // CUS_PKT4: PREAM_VALUE
  Serial.println("[RADIO] Long-Preamble Register gesetzt (300 units)");
}

bool applyPreambleProfileIfNeeded(uint8_t newProfile) {
  if (currentTxProfile == newProfile) {
    return false; // nichts zu tun
  }

  // WICHTIG: Chip MUSS im Standby sein, wenn das aufgerufen wird!
  if (newProfile == TX_PROFILE_LONG) {
    applyLongPreambleRegisters();
  } else {
    applyShortPreambleRegisters();
  }

  currentTxProfile = newProfile;
  Serial.printf("[RADIO] TX-Profil gewechselt auf: %s\n", txProfileToString(currentTxProfile));
  return true;
}

// ============================================================
// Hardware UI (LED & Button)
// ============================================================

void handleHardwareUI() {
  uint32_t currentMs = millis();

  // --- 1. LED Blink-Logik ---
  if (!tcpLedOverride) {
    uint32_t blinkInterval = 0;
    
    if (currentSystemState == STATE_UNCONFIGURED) {
      blinkInterval = 100; // Schnelles Blinken (Portal aktiv)
    } else if (currentSystemState == STATE_CONNECTING) {
      blinkInterval = 500; // Langsames Blinken (Sucht WLAN)
    }

    if (blinkInterval > 0) {
      if (currentMs - lastLedToggleMs >= blinkInterval) {
        lastLedToggleMs = currentMs;
        ledState = !ledState;
        digitalWrite(PIN_LED, ledState);
      }
    } else {
      // STATE_CONNECTED: LED ist standardmäßig aus
      if (ledState != HIGH) {
        ledState = HIGH;
        digitalWrite(PIN_LED, ledState);
      }
    }
  }

  // --- 2. Button Logik (Kugelsicheres Polling Debouncing) ---
  bool currentReading = digitalRead(PIN_BUTTON);

  // Wenn sich das physische Signal ändert (auch beim Prellen), Timer resetten
  if (currentReading != lastRawButtonState) {
    lastDebounceTime = currentMs; 
  }

  // Wenn das Signal länger als 50ms stabil anliegt (Prellen ist vorbei)
  if ((currentMs - lastDebounceTime) >= DEBOUNCE_DELAY_MS) {
    
    // Und wenn dieser stabile Zustand wirklich neu ist
    if (currentReading != lastButtonState) {
      lastButtonState = currentReading;

      // Zustand via TCP an NodeJS melden
      if (currentReading == LOW) {
        sendLineToClientAndSerial("BTN:PRESSED");
      } else {
        sendLineToClientAndSerial("BTN:RELEASED");
      }
    }
  }

  // Aktuelles Signal für den nächsten Loop merken
  lastRawButtonState = currentReading;
}

// ============================================================
// Interrupt
// ============================================================
void IRAM_ATTR onPacketReceived() {
  packetInterruptCount++;
}

// ============================================================
// Setup / Loop
// ============================================================
void setup() {

  Serial.begin(115200);

  Serial.println();
  Serial.println("========================================");
  Serial.println("Diivoo TCP Gateway startet");
  Serial.println("========================================");
  Serial.println("[BOOT] Initialisiere Hardware ...");

  // Hardware UI initialisieren
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, HIGH); // LED standardmäßig aus
  
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  //attachInterrupt(digitalPinToInterrupt(PIN_BUTTON), isrButton, CHANGE); removed too flacky if you flick the button it gets digitally stuck..
  
  inputBufferLen = 0;
  inputBuffer[0] = '\0';

  WiFi.persistent(false);

  if (!connectToStoredWiFi()) {
    startConfigPortal();
  }

  server.begin();

  pinMode(PIN_VCC_EN, OUTPUT);
  pinMode(PIN_SCLK, OUTPUT);
  pinMode(PIN_SDIO, OUTPUT);
  pinMode(PIN_CSB, OUTPUT);
  pinMode(PIN_FCSB, OUTPUT);
  pinMode(PIN_INTERRUPT, INPUT_PULLDOWN);

  digitalWrite(PIN_VCC_EN, LOW);
  digitalWrite(PIN_CSB, HIGH);
  digitalWrite(PIN_FCSB, HIGH);
  digitalWrite(PIN_SDIO, HIGH);
  digitalWrite(PIN_SCLK, LOW);
  delay(100);

  executeInitSequence();

  // Wie bisher: nach Init nochmal explizit auf aktuellen RX-Kanal gehen
  cmtGoStandby();
  cmtSelectChannel(currentRxChannel);
  Serial.println("[BOOT] RF-Initialisierung abgeschlossen.");
  Serial.printf("[BOOT] Standard RX-Kanal: %u\n", currentRxChannel);
  cmtGoRx();

  attachInterrupt(digitalPinToInterrupt(PIN_INTERRUPT), onPacketReceived, RISING);
  
  Serial.println("Eingehende Befehle über Serial/TCP:");
  Serial.println("  TUNE:<tx>:<rx>[:<profile>]  (profile: short/long, optional)");
  Serial.println("  TX:<hex>");
  Serial.println("  LED:ON / LED:OFF");
  Serial.println("  OTA:<url>");
  Serial.println("  PING_URL:<url>  (prueft ob URL erreichbar ist -> ACK:PING_OK / ERR:PING_UNREACHABLE)");
  Serial.println("  VERSION");
  Serial.println("  PORTAL");
  Serial.println("  CLEARWIFI");
  Serial.println("  WIFI");
  Serial.println("----------------------------------------");
  Serial.println("Ausgehende Events (via TCP):");
  Serial.println("  BTN:PRESSED");
  Serial.println("  BTN:RELEASED");
  Serial.println("========================================");

  Serial.println("Warte auf Pakete...");
}

void loop() {
  serviceSerialInput();
  serviceConfigPortal();
  serviceDeferredActions();
  handleHardwareUI();

  serviceClientLifecycle();
  serviceClientInput();

  while (takePendingPacketInterrupt()) {
    handleReceivedPacket();
  }

  delay(1);
}
