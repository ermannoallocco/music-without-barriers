#include <Ticker.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <DacESP32.h>

//Setup
BLEServer* pServer = NULL;
BLECharacteristic* pSensorCharacteristic = NULL; // Nota: questa variabile è dichiarata ma non usata nel codice fornito.
BLECharacteristic* pLedCharacteristic = NULL;
BLECharacteristic* pNotesCharacteristic = NULL;
bool deviceConnected = false;
bool oldDeviceConnected = false;
uint32_t value = 0; // Nota: questa variabile è dichiarata ma non usata nel codice fornito.

// Create DAC object
DacESP32 dac1(GPIO_NUM_25);
Ticker tickNotes;
Ticker tick;

// Use the appropriate GPIO pin for your setup
const int buzzPin = 32; // Pin per il buzzer (o DAC se usato come tale per il buzz)
const int ledGreenPin = 5; // Led pin

int current_note = 0;

#define SERVICE_UUID              "19b10000-e8f2-537e-4f6c-d104768a1214"
#define LED_CHARACTERISTIC_UUID   "19b10002-e8f2-537e-4f6c-d104768a1214"
#define NOTES_CHARACTERISTIC_UUID "39114440-f153-414b-9ca8-cd739acad81c"

class MyServerCallbacks: public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) {
    deviceConnected = true;
  };

  void onDisconnect(BLEServer* pServer) {
    deviceConnected = false;
  }
};

void functionDac(int firstValue){
  dac1.enable();
  dac1.outputCW(firstValue); // Imposta la frequenza del DAC
  tickNotes.once(3, [](){    // Dopo 3 secondi...
    dac1.disable();         // ...disabilita il DAC
  });
}

void buzzBeat() {
  digitalWrite(buzzPin, HIGH); // Attiva il buzzer
  tick.once(0.1, [](){         // Dopo 0.1 secondi...
    digitalWrite(buzzPin,LOW); // ...disattiva il buzzer
  });
}

// Callback per la caratteristica delle NOTE
class CharacteristicCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) { // Il parametro è la caratteristica che ha ricevuto dati
    // CORREZIONE: Converti Arduino String in std::string usando .c_str()
    std::string value_str = pCharacteristic->getValue().c_str();

    // Assicurati che ci siano almeno due byte prima di accedervi
    if (value_str.length() >= 2) {
        current_note = static_cast<uint8_t>(value_str[0]) | (static_cast<uint8_t>(value_str[1]) << 8);
        // Nota: la funzione functionDac(current_note) non viene chiamata qui.
        // current_note sarà usato nel loop() principale.
    }
    // Check print
    // Serial.print("Nota ricevuta (valore grezzo): ");
    // Serial.println(current_note);
  }
};

// Callback per la caratteristica del LED/METRONOMO
class MyCharacteristicCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) { // Il parametro è la caratteristica che ha ricevuto dati
    // CORREZIONE: Converti Arduino String in std::string usando .c_str()
    std::string value_str = pCharacteristic->getValue().c_str();
    
    if (!value_str.empty()) { // Controlla se la stringa non è vuota
        int value_number = static_cast<int>(value_str[0]); // Prende il primo byte come comando
        if(value_number == 1) {
        // Serial.println("Comando BuzzBeat ricevuto");
        buzzBeat(); // Esegue il suono del metronomo
        } else {
        // Serial.println("Comando Stop DAC ricevuto");
        functionDac(0); // Ferma il DAC impostando la frequenza a 0
        // Se si vuole fermare immediatamente la nota impostata da current_note nel loop,
        // si potrebbe anche impostare current_note = 0; qui.
        // dac1.outputCW(0); // Potrebbe essere più diretto per fermare il suono
        // dac1.disable();
        }
    }
  }
};

void setup() {
  Serial.begin(115200);
  pinMode(buzzPin, OUTPUT);
  pinMode(ledGreenPin, OUTPUT);
  // dac1.enable(); // È meglio abilitare il DAC solo quando serve, cioè in functionDac

// Create the BLE Device
  BLEDevice::init("ESP32"); // Inizializza il dispositivo BLE con nome "ESP32"

// Create the BLE Server
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

// Create the BLE Service
  BLEService *pService = pServer->createService(SERVICE_UUID);

// Create the LED button Characteristic (per il metronomo)
  pLedCharacteristic = pService->createCharacteristic(
                      LED_CHARACTERISTIC_UUID,
                      BLECharacteristic::PROPERTY_WRITE_NR  // NR = No Response (Write Without Response)
                    );

// Create the Notes Characteristic
  pNotesCharacteristic = pService->createCharacteristic(
                      NOTES_CHARACTERISTIC_UUID,
                      BLECharacteristic::PROPERTY_WRITE_NR
                    );

// Register the callback for the LED characteristic
  pLedCharacteristic->setCallbacks(new MyCharacteristicCallbacks());
// Register the callback for the NOTES characteristic
  pNotesCharacteristic->setCallbacks(new CharacteristicCallbacks());


// Start the service
  pService->start();

// Start advertising
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(false);
  pAdvertising->setMinPreferred(0x0);  // set value to 0x00 to not advertise this parameter
  BLEDevice::startAdvertising();
  Serial.println("In attesa di una connessione client per notificare...");
}

void loop() {
  
  if (!deviceConnected && oldDeviceConnected) {
    Serial.println("Dispositivo disconnesso.");
    digitalWrite(ledGreenPin, LOW); // Spegne il LED
    delay(500); // Pausa per dare allo stack bluetooth il tempo di prepararsi
    pServer->startAdvertising(); // Riavvia l'advertising
    Serial.println("Advertising avviato");
    oldDeviceConnected = deviceConnected;
  }
  // Connessione stabilita
  if (deviceConnected && !oldDeviceConnected) {
    // Azioni da eseguire alla connessione
    oldDeviceConnected = deviceConnected;
    digitalWrite(ledGreenPin, HIGH); // Accende il LED
    Serial.println("Dispositivo Connesso");
  }

  // Questa riga nel loop() farà suonare continuamente la current_note.
  // Se functionDac() viene chiamata per impostare una nota e poi si ferma dopo 3 secondi,
  // questa riga la farà ripartire immediatamente ad ogni ciclo del loop().
  // Potrebbe essere necessario rivedere questa logica se vuoi che la nota suoni solo per 3 secondi.
  if (deviceConnected && current_note != 0) { // Controlla se connesso e se c'è una nota da suonare
      dac1.enable(); // Abilita il DAC se non già abilitato
      dac1.outputCW(current_note);
  } else if (!deviceConnected || current_note == 0) {
      // Se disconnesso o current_note è 0, assicurati che il DAC sia spento.
      // dac1.outputCW(0); // Imposta frequenza a 0
      // dac1.disable(); // Disabilita il DAC
      // È importante considerare che functionDac ha un suo timer per disabilitare il DAC.
      // Se current_note viene impostata a 0 dalla callback del LED,
      // allora questa sezione aiuterà a mantenere il DAC silente.
  }
}