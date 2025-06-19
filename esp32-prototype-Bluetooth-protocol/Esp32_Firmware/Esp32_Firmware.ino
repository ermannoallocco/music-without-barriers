#include <Ticker.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <DacESP32.h>
#include <esp_task_wdt.h> // Libreria per il Watchdog Timer

// Impostazioni Watchdog: se non riceve "cibo" per 3 secondi, resetta.
#define WDT_TIMEOUT_S 3 // Timeout in SECONDI

//Setup
BLEServer* pServer = NULL;
BLECharacteristic* pVibrationCharacteristic = NULL;
BLECharacteristic* pNotesCharacteristic = NULL;
bool deviceConnected = false;
bool oldDeviceConnected = false;

// Create DAC object
DacESP32 dac1(GPIO_NUM_25);
bool dacActive = false;
Ticker tick;

// Use the appropriate GPIO pin for your setup
const int buzzPin = 32;
const int ledGreenPin = 5;

volatile int current_note = 0;

// UUIDs
#define SERVICE_UUID                  "19b10000-e8f2-537e-4f6c-d104768a1214"
#define VIBRATION_CHARACTERISTIC_UUID "19b10002-e8f2-537e-4f6c-d104768a1214"
#define NOTES_CHARACTERISTIC_UUID     "39114440-f153-414b-9ca8-cd739acad81c"

// ... (Le tue classi di Callback MyServerCallbacks, NotesCharacteristicCallbacks, VibrationCharacteristicCallbacks rimangono IDENTICHE) ...
class MyServerCallbacks: public BLEServerCallbacks {
  void onConnect(BLEServer* pServerInstance) { 
    deviceConnected = true;
    Serial.println("Dispositivo Connesso al Server BLE.");
  };

  void onDisconnect(BLEServer* pServerInstance) {
    deviceConnected = false;
    Serial.println("Dispositivo Disconnesso dal Server BLE.");
    if (dacActive) {
        dac1.outputCW(0);
        dac1.disable();
        dacActive = false;
        Serial.println("DAC disabilitato a causa della disconnessione.");
    }
    current_note = 0;
  }
};

void stopDac() {
  dac1.outputCW(0); 
  dac1.disable();   
  dacActive = false;
  // Serial.println("DAC Stoppato e Disabilitato."); // Riduciamo i log per non intasare
}

void enableDac() {
    if (!dacActive) {
        dac1.enable();
        dacActive = true;
        // Serial.println("DAC Abilitato.");
    }
}

void buzzBeat() {
  digitalWrite(buzzPin, HIGH); 
  tick.once_ms(100, [](){      
    digitalWrite(buzzPin,LOW); 
  });
}

class NotesCharacteristicCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) {
    String arduino_value_str = pCharacteristic->getValue();
    std::string value_str(arduino_value_str.c_str());

    if (value_str.length() >= 2) { 
        current_note = (static_cast<uint8_t>(value_str[1]) << 8) | static_cast<uint8_t>(value_str[0]);
        if (current_note == 0) {
            stopDac(); 
        } else {
            enableDac();
        }
    } else if (value_str.length() == 1 && static_cast<uint8_t>(value_str[0]) == 0) {
        current_note = 0;
        stopDac();
    } 
  }
};

class VibrationCharacteristicCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) {
    String arduino_value_str = pCharacteristic->getValue();
    std::string value_str(arduino_value_str.c_str());
    
    if (!value_str.empty()) {
        uint16_t command_value = 0;
        if (value_str.length() >= 1) { 
            command_value = static_cast<uint8_t>(value_str[0]);
        }

        if(command_value == 1) {
          buzzBeat();
        } else if (command_value == 0) {
          current_note = 0; 
          stopDac();        
        } 
    }
  }
};
// ... (Fine delle classi Callback che rimangono invariate) ...


void setup() {
  Serial.begin(115200);
  pinMode(buzzPin, OUTPUT);
  digitalWrite(buzzPin, LOW); 
  pinMode(ledGreenPin, OUTPUT);
  digitalWrite(ledGreenPin, LOW); 

  Serial.println("Inizializzazione ESP32...");
  
  // --- INIZIALIZZAZIONE WATCHDOG TIMER (METODO CORRETTO PER IDF v5.x) ---
  Serial.println("Configurazione Watchdog Timer...");
  esp_task_wdt_config_t wdt_config = {
    .timeout_ms = WDT_TIMEOUT_S * 1000,
    .idle_core_mask = (1 << portNUM_PROCESSORS) - 1,    // Controlla i task idle su tutti i core
    .trigger_panic = true
  };
  ESP_ERROR_CHECK(esp_task_wdt_init(&wdt_config));
  Serial.println("Watchdog Timer inizializzato.");
  
  Serial.println("Sottoscrizione del task principale (loop) al Watchdog...");
  ESP_ERROR_CHECK(esp_task_wdt_add(NULL)); // Aggiunge il task corrente al watchdog
  Serial.println("Task principale sottoscritto.");
  // ------------------------------------

  BLEDevice::init("GIACOMINO");
  
  // Imposta la potenza di trasmissione BLE (già presente, la lasciamo)
  esp_ble_tx_power_set(ESP_BLE_PWR_TYPE_DEFAULT, ESP_PWR_LVL_P9);
  Serial.println("Potenza Tx BLE impostata al livello P9 (+9dBm).");

  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

  BLEService *pService = pServer->createService(SERVICE_UUID);

  pVibrationCharacteristic = pService->createCharacteristic(
                                VIBRATION_CHARACTERISTIC_UUID,
                                BLECharacteristic::PROPERTY_WRITE 
                              );
  pVibrationCharacteristic->setCallbacks(new VibrationCharacteristicCallbacks());

  pNotesCharacteristic = pService->createCharacteristic(
                            NOTES_CHARACTERISTIC_UUID,
                            BLECharacteristic::PROPERTY_WRITE_NR 
                         );
  pNotesCharacteristic->setCallbacks(new NotesCharacteristicCallbacks());

  pService->start();

  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true); 
  pAdvertising->setMinPreferred(0x06);  
  pAdvertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();
  Serial.println("Dispositivo in Advertising, in attesa di connessione...");
}

void loop() {
  // --- DAI "CIBO" AL WATCHDOG AD OGNI CICLO ---
  esp_task_wdt_reset(); // Resetta il timer del watchdog
  // -------------------------------------------

  if (!deviceConnected && oldDeviceConnected) {
    Serial.println("Loop: Dispositivo disconnesso.");
    digitalWrite(ledGreenPin, LOW);
    if (pServer) {
        pServer->startAdvertising(); 
        Serial.println("Loop: Advertising riavviato.");
    }
    oldDeviceConnected = deviceConnected;
  }
  
  if (deviceConnected && !oldDeviceConnected) {
    Serial.println("Loop: Dispositivo connesso.");
    digitalWrite(ledGreenPin, HIGH);
    oldDeviceConnected = deviceConnected;
  }

  if (deviceConnected) {
    if (current_note != 0) {
      if (!dacActive) {
        enableDac();
      }
      dac1.outputCW(current_note);
    } else { 
      if (dacActive) {
        stopDac();
      }
    }
  } else { 
      if (dacActive) {
          stopDac();
      }
  }

  // Aggiungiamo un piccolo delay per non sovraccaricare il loop
  delay(1); 
}
