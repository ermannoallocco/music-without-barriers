//verimmDAI1234567
// load elements
const wrapper = document.querySelector(".at-wrap");
const main = wrapper.querySelector(".at-main");
const urlParams = new URLSearchParams(window.location.search);
const urlFileName = urlParams.get("filename");
let connectedBleDevices = new Map(); // Questa crea la mappa vuota per i dispositivi
let lastNoteSentTimestamp = 0;
const MIN_NOTE_INTERVAL_MS = 100; // Intervallo minimo in ms tra invii di note diverse. Prova con 100ms.
                                 // Se hai ancora problemi, potresti aumentarlo (es. 150 o 200).
let lastSentNoteValue = null; // Per tenere traccia dell'ultima nota inviata (frequenza o 0)


// initialize alphatab
const settings = {
  file: urlFileName ?? "/file.xml",
  player: {
    enablePlayer: true,
    enableCursor: true,
    enableUserInteraction: true,
    soundFont: "/dist/soundfont/sonivox.sf2",
    scrollElement: wrapper.querySelector(".at-viewport"),
  },
};
let api = new alphaTab.AlphaTabApi(main, settings);
let timeSignaturePauses = [];
let metronomeWorker = null;
api.masterVolume = 1;

const inputElement = document.getElementById("input-file");
if (urlFileName) {
  document.getElementById("custom-input-file").style.display = "none";
}
inputElement.addEventListener("change", onUploadedFile, false);
function onUploadedFile() {
  const file = this.files[0];
  let reader = new FileReader();
  reader.onload = function (e) {
    let arrayBuffer = new Uint8Array(reader.result);
    api.load(arrayBuffer);
  };
  reader.readAsArrayBuffer(file);
}

//----------- BLE LOGIC ------------

//Setup buttons bluetooth
const connectButton = document.querySelector(".connect");
const disconnectButton = document.querySelector(".disconnect");
const deviceName = 'ESP32'; // Il nome che i tuoi ESP32 usano per farsi trovare
const bleService = '19b10000-e8f2-537e-4f6c-d104768a1214'; // L'UUID del servizio principale sui tuoi ESP32
const vibrationCharacteristicUUID = '19b10002-e8f2-537e-4f6c-d104768a1214'; // L'UUID della caratteristica per la vibrazione
const notesCharacteristicUUID = '39114440-f153-414b-9ca8-cd739acad81c'; // L'UUID della caratteristica per le note

// Connect Button (search for BLE Devices only if BLE is available)
connectButton.addEventListener("click", (event) => {
  if (isWebBluetoothEnabled()) {
    connectToDevice();
  }
});

// Disconnect Button
disconnectButton.addEventListener("click", disconnectDevice);

//Check if the browser supports bluetooth web api
function isWebBluetoothEnabled() {
  if (!navigator.bluetooth) {
    console.log("Web Bluetooth API is not available in this browser!");
    window.alert("Web Bluetooth API is not available in this browser!");
    return false;
  }

  // console.log('Web Bluetooth API supported in this browser.');
  // window.alert("Web Bluetooth API supported in this browser.");
  return true;
}

function connectToDevice() {
  console.log("Inizializzazione connessione Bluetooth...");
  let deviceInstance;
  let gattServerInstance;

  navigator.bluetooth
    .requestDevice({
      filters: [{ name: deviceName  },
        { name: "ALDO" },
        { name: "GIOVANNI" },
        { name: "GIACOMINO" }],
      optionalServices: [bleService],
    })
    .then((device) => {
      deviceInstance = device;
      console.log("Dispositivo selezionato:", deviceInstance.name, "(ID:", deviceInstance.id, ")");
      if (connectedBleDevices.has(deviceInstance.id) && connectedBleDevices.get(deviceInstance.id).connected) {
        throw new Error("Dispositivo già connesso.");
      }
      deviceInstance.addEventListener("gattserverdisconnected", onDisconnected);
      return deviceInstance.gatt.connect();
    })
    .then((gattServer) => {
      gattServerInstance = gattServer;
      return gattServerInstance.getPrimaryService(bleService);
    })
    .then((service) => {
      if (!service) throw new Error("Servizio primario non trovato.");
      return Promise.all([
        service.getCharacteristic(vibrationCharacteristicUUID).catch(err => { console.error("Errore ottenimento VibrationChar:", err); return null; }),
        service.getCharacteristic(notesCharacteristicUUID).catch(err => { console.error("Errore ottenimento NotesChar:", err); return null; }),
        Promise.resolve(service),
        Promise.resolve(gattServerInstance)
      ]);
    })
    .then(([vibrationCharInstance, notesCharInstance, serviceInstance, resolvedGattServer]) => {
      if (!vibrationCharInstance || !notesCharInstance) {
        if (resolvedGattServer && resolvedGattServer.connected) resolvedGattServer.disconnect();
        throw new Error("Caratteristiche essenziali non trovate.");
      }
      
      const deviceInfo = {
        id: deviceInstance.id,
        name: deviceInstance.name,
        server: resolvedGattServer,
        service: serviceInstance,
        vibrationChar: vibrationCharInstance,
        notesChar: notesCharInstance,
        connected: true,
        isProcessingVibrationQueue: false, // Flag per la coda delle vibrazioni
        isProcessingNotesQueue: false,     // Flag per la coda delle note
        vibrationQueue: [],                // Coda per i comandi di vibrazione
        notesQueue: []                     // Coda per i comandi delle note
      };

      connectedBleDevices.set(deviceInstance.id, deviceInfo);
      console.log("Dispositivo aggiunto alla lista:", deviceInfo.name, ". Dispositivi totali:", connectedBleDevices.size);
    })
    .catch((error) => {
      console.error("Errore durante il processo di connessione per " + (deviceInstance ? deviceInstance.name : "un dispositivo") + ":", error.message);
      if (deviceInstance) deviceInstance.removeEventListener("gattserverdisconnected", onDisconnected);
    });
}

/**
 * Gestisce l'evento di disconnessione imprevista di un dispositivo.
 */
function onDisconnected(event) {
  const disconnectedDevice = event.target;
  console.warn("DISCONNESSO: Il dispositivo", disconnectedDevice.name, "(ID:", disconnectedDevice.id, ") si è disconnesso.");

  if (connectedBleDevices.has(disconnectedDevice.id)) {
    const deviceInfo = connectedBleDevices.get(disconnectedDevice.id);
    deviceInfo.connected = false;
    deviceInfo.isProcessingVibrationQueue = false;
    deviceInfo.isProcessingNotesQueue = false;
    deviceInfo.vibrationQueue = []; // Svuota le code alla disconnessione
    deviceInfo.notesQueue = [];
    console.log("Stato e code del dispositivo", disconnectedDevice.name, "resettati.");
  }

  let stillConnectedCount = 0;
  connectedBleDevices.forEach(dev => {
    if (dev.connected) stillConnectedCount++;
  });
  if (stillConnectedCount === 0 && typeof api !== 'undefined' && api && api.playerState === alphaTab.synth.PlayerState.Playing) {
    console.log("Tutti i dispositivi sono disconnessi. Messa in pausa della riproduzione.");
    if (typeof metronomeWorker !== 'undefined' && metronomeWorker) {
        metronomeWorker.terminate();
        metronomeWorker = null;
    }
    api.playPause();
    if (typeof noteLogger !== 'undefined' && noteLogger) noteLogger.innerHTML = "";
    if (typeof beatLogger !== 'undefined' && beatLogger) beatLogger.innerHTML = "";
  }
}

/**
 * Disconnette tutti i dispositivi BLE attualmente connessi.
 */
function disconnectDevice() {
  console.log("Tentativo di disconnettere tutti i dispositivi...");
  connectedBleDevices.forEach((deviceInfo, deviceId) => {
    if (deviceInfo.server && deviceInfo.server.connected) {
      deviceInfo.server.disconnect(); // L'evento onDisconnected gestirà il cleanup
    }
  });
  connectedBleDevices.clear(); // Pulisce la mappa
  console.log("Mappa dei dispositivi connessi svuotata.");

  if (typeof api !== 'undefined' && api && typeof api.playPause === 'function' && api.playerState === alphaTab.synth.PlayerState.Playing) {
    console.log("Messa in pausa della riproduzione di AlphaTab.");
    api.playPause();
  }
  if (typeof noteLogger !== 'undefined' && noteLogger) {
    noteLogger.innerHTML = "";
  }
  if (typeof beatLogger !== 'undefined' && beatLogger) {
    beatLogger.innerHTML = "";
  }
  if (typeof metronomeWorker !== 'undefined' && metronomeWorker) {
    console.log("Terminazione del metronomeWorker.");
    metronomeWorker.terminate();
    metronomeWorker = null;
  }
}


// Convesion table
const conversion = {
  48: 130.81,
  49: 138.59,
  50: 146.83,
  51: 155.56,
  52: 164.81,
  53: 174.61,
  54: 185.0,
  55: 196.0,
  56: 207.65,
  57: 220.0,
  58: 233.08,
  59: 246.94,
  60: 261.63,
  61: 277.18,
  62: 293.67,
  63: 311.13,
  64: 329.63,
  65: 349.23,
  66: 369.99,
  67: 392.0,
  68: 415.3,
  69: 440.0,
  70: 466.16,
  71: 493.88,
  72: 523.25,
  73: 554.37,
  74: 587.33,
  75: 622.25,
  76: 659.36,
  77: 689.46,
  78: 739.99,
  79: 783.99,
  80: 830.61,
  81: 880.0,
  82: 932.33,
  83: 987.77,
};

//Convert MIDI to Frequency
function convertMidiToFrequency(midi) {
  if (midi < 48) {
    return conversion[midi] || 48; //Return 48 if under the scale
  }
  if (midi > 83) {
    return conversion[midi] || 83; // Return 83 if upper the scale
  }
  return conversion[midi];
}

function sendValueToBleDevices(value) {
    if (!connectedBleDevices || connectedBleDevices.size === 0) {
        return;
    }

    const command = {
        value: value,
        timestamp: Date.now() // Aggiungiamo un timestamp al momento della creazione del comando
    };

    connectedBleDevices.forEach((deviceInfo) => {
        if (!deviceInfo.connected) return;

        // Determina la coda corretta
        if (value === 1) { // Comando per la vibrazione
            deviceInfo.vibrationQueue.push(command);
            processVibrationQueue(deviceInfo);
        } else { // Comando per le note (frequenza o STOP 0)
            const lastNoteInQueue = deviceInfo.notesQueue[deviceInfo.notesQueue.length - 1];
            // Ottimizzazione: non aggiungere comandi di nota duplicati consecutivi.
            if (!lastNoteInQueue || lastNoteInQueue.value !== value) {
                deviceInfo.notesQueue.push(command);
            }
            processNotesQueue(deviceInfo);
        }
    });
}


/**
 * Processa la coda dei comandi per la caratteristica delle note di un dispositivo.
 * Invia un comando alla volta, loggando la latenza e la dimensione della coda.
 * @param {object} deviceInfo - L'oggetto del dispositivo dalla mappa connectedBleDevices.
 */
function processNotesQueue(deviceInfo) {
    if (deviceInfo.isProcessingNotesQueue || deviceInfo.notesQueue.length === 0 || !deviceInfo.connected) {
        return; // Non fare nulla se stiamo già inviando, la coda è vuota o il device è disconnesso
    }

    deviceInfo.isProcessingNotesQueue = true; // Blocca la coda
    const command = deviceInfo.notesQueue.shift(); // Prendi il primo comando (che è un oggetto)
    const valueToSend = command.value;
    const data = new Uint16Array([valueToSend]);
    
    // Calcola la latenza: il tempo trascorso da quando il comando è stato creato
    const latency = Date.now() - command.timestamp;
    
    // Logga le informazioni di performance PRIMA dell'invio
    console.log(`CODA NOTE per ${deviceInfo.name}: Dimensione=${deviceInfo.notesQueue.length}, Latenza=${latency}ms`);

    deviceInfo.notesChar.writeValueWithoutResponse(data)
        .then(() => {
            // Log di successo opzionale, i log di performance sono più importanti ora
            // console.log(`LOG CODA: Nota (${valueToSend}) inviata (no-resp) a ${deviceInfo.name}`);
        })
        .catch(error => {
            console.error(`LOG CODA: Errore invio Nota (${valueToSend}) a ${deviceInfo.name}:`, error);
            if (error.name === 'NetworkError') {
                deviceInfo.connected = false; 
                deviceInfo.notesQueue = [];   
            }
        })
        .finally(() => {
            deviceInfo.isProcessingNotesQueue = false; 
            setTimeout(() => processNotesQueue(deviceInfo), 0);
        });
}

/**
 * Processa la coda dei comandi per la caratteristica delle vibrazioni di un dispositivo.
 * Invia un comando alla volta, loggando la latenza e la dimensione della coda.
 * @param {object} deviceInfo - L'oggetto del dispositivo dalla mappa connectedBleDevices.
 */
function processVibrationQueue(deviceInfo) {
    if (deviceInfo.isProcessingVibrationQueue || deviceInfo.vibrationQueue.length === 0 || !deviceInfo.connected) {
        return;
    }

    deviceInfo.isProcessingVibrationQueue = true;
    const command = deviceInfo.vibrationQueue.shift(); // Prendi il primo comando (oggetto)
    const valueToSend = command.value;
    const data = new Uint16Array([valueToSend]);
    
    const latency = Date.now() - command.timestamp;
    
    console.log(`CODA VIBRAZIONE per ${deviceInfo.name}: Dimensione=${deviceInfo.vibrationQueue.length}, Latenza=${latency}ms`);

    deviceInfo.vibrationChar.writeValueWithResponse(data)
        .then(() => {
            // console.log(`LOG CODA: Vibrazione (${valueToSend}) inviata a ${deviceInfo.name}`);
        })
        .catch(error => {
            console.error(`LOG CODA: Errore invio Vibrazione (${valueToSend}) a ${deviceInfo.name}:`, error);
            if (error.name === 'NetworkError') {
                deviceInfo.connected = false;
                deviceInfo.vibrationQueue = [];
            }
        })
        .finally(() => {
            deviceInfo.isProcessingVibrationQueue = false;
            setTimeout(() => processVibrationQueue(deviceInfo), 0); // Prova a processare il prossimo
        });
}


function getDateTime() {
  var currentdate = new Date();
  var day = ("00" + currentdate.getDate()).slice(-2);
  var month = ("00" + (currentdate.getMonth() + 1)).slice(-2);
  var year = currentdate.getFullYear();
  var hours = ("00" + currentdate.getHours()).slice(-2);
  var minutes = ("00" + currentdate.getMinutes()).slice(-2);
  var seconds = ("00" + currentdate.getSeconds()).slice(-2);
  var milliseconds = ("00" + currentdate.getMilliseconds()).slice(-3);
  var datetime =
    day +
    "/" +
    month +
    "/" +
    year +
    " at " +
    hours +
    ":" +
    minutes +
    ":" +
    seconds +
    ":" +
    milliseconds;
  return datetime;
}

//---------- END BLE LOGIC --------------

// overlay logic
const overlay = wrapper.querySelector(".at-overlay");
api.renderStarted.on(() => {
  overlay.style.display = "flex";
});
api.renderFinished.on(() => {
  overlay.style.display = "none";
});

// track selector
function createTrackItem(track) {
  const trackItem = document
    .querySelector("#at-track-template")
    .content.cloneNode(true).firstElementChild;
  trackItem.querySelector(".at-track-name").innerText = track.name;
  trackItem.track = track;
  trackItem.onclick = (e) => {
    e.stopPropagation();
    api.renderTracks([track]);
  };
  return trackItem;
}

function createMetronome(score) {
  let tempoAutomation = 0;
  score.masterBars.forEach((bar) => {
    if (
      bar.tempoAutomation != null &&
      tempoAutomation != bar.tempoAutomation.value
    ) {
      tempoAutomation = bar.tempoAutomation.value;
    }
    let barDuration =
      parseFloat(60 / parseInt(tempoAutomation)) *
      parseInt(bar.timeSignatureNumerator);
    if (parseInt(bar.timeSignatureNumerator) == 0) return;
    let beatsWaitTime = barDuration / parseInt(bar.timeSignatureNumerator);
    for (
      let index = 1;
      index <= parseInt(bar.timeSignatureNumerator);
      index++
    ) {
      if (index == 1) {
        timeSignaturePauses.push({
          waitTime: beatsWaitTime,
          isFirstBeat: true,
        });
      } else {
        timeSignaturePauses.push({
          waitTime: beatsWaitTime,
          isFirstBeat: false,
        });
      }
    }
  });
}

const trackList = wrapper.querySelector(".at-track-list");
api.scoreLoaded.on((score) => {
  // clear items
  trackList.innerHTML = "";
  // generate a track item for all tracks of the score
  score.tracks.forEach((track) => {
    trackList.appendChild(createTrackItem(track));
  });
  createMetronome(score);
});
api.renderStarted.on(() => {
  // collect tracks being rendered
  const tracks = new Map();
  api.tracks.forEach((t) => {
    tracks.set(t.index, t);
  });
  // mark the item as active or not
  const trackItems = trackList.querySelectorAll(".at-track");
  trackItems.forEach((trackItem) => {
    if (tracks.has(trackItem.track.index)) {
      trackItem.classList.add("active");
    } else {
      trackItem.classList.remove("active");
    }
  });
});

/** Controls **/
api.scoreLoaded.on((score) => {
  wrapper.querySelector(".at-song-title").innerText = score.title;
  wrapper.querySelector(".at-song-artist").innerText = score.artist;
});

wrapper.querySelector(".at-controls .at-print").onclick = () => {
  api.print();
};

const zoom = wrapper.querySelector(".at-controls .at-zoom select");
zoom.onchange = () => {
  const zoomLevel = parseInt(zoom.value) / 100;
  api.settings.display.scale = zoomLevel;
  api.updateSettings();
  api.render();
};

const layout = wrapper.querySelector(".at-controls .at-layout select");
layout.onchange = () => {
  switch (layout.value) {
    case "horizontal":
      api.settings.display.layoutMode = alphaTab.LayoutMode.Horizontal;
      break;
    case "page":
      api.settings.display.layoutMode = alphaTab.LayoutMode.Page;
      break;
  }
  api.updateSettings();
  api.render();
};

// player loading indicator
const playerIndicator = wrapper.querySelector(
  ".at-controls .at-player-progress"
);
api.soundFontLoad.on((e) => {
  const percentage = Math.floor((e.loaded / e.total) * 100);
  playerIndicator.innerText = percentage + "%";
});
api.playerReady.on(() => {
  playerIndicator.style.display = "none";
});

// main player controls
function getCurrentBarIndex(currentTick) {
  return api.score.masterBars
    .map((el) => el.start <= currentTick)
    .lastIndexOf(true);
}
const beatSignaler = document.getElementById("beat-signaler");
const beatLogger = document.getElementById("beat-logger");
const noteLogger = document.getElementById("note-logger");
function highlightBeat(color) {
  beatSignaler.style.color = color;
  beatSignaler.style.display = "block";
  setTimeout(function () {
    beatSignaler.style.display = "none";
  }, 100);
}
const playPause = wrapper.querySelector(".at-controls .at-player-play-pause");
const stop = wrapper.querySelector(".at-controls .at-player-stop");
playPause.onclick = (e) => {
  if (e.target.classList.contains("disabled")) {
    return;
  }
  if (e.target.classList.contains("fa-play")) {
    let currentBarIndex = getCurrentBarIndex(api.tickPosition);
    api.tickPosition = api.score.masterBars[currentBarIndex].start;
    metronomeWorker = new Worker("/js/metronomeWorker.js");
    beatLogger.innerHTML = "";
    metronomeWorker.postMessage({
      startIndex: currentBarIndex,
      pauses: timeSignaturePauses,
    });
    metronomeWorker.onmessage = function (message) {
      //if (timeWebSocket.readyState != 1) return;
      if (message.data.isFirstBeat) {
        beatLogger.innerHTML = '<p style="color: green;">BEAT</p>';
        //Send beat to the device
        sendValueToBleDevices(1);
        highlightBeat("green");
      } else {
        beatLogger.innerHTML += '<p style="color: red;">BEAT</p>';
        //Send beat to the device
        sendValueToBleDevices(1);
        highlightBeat("red");
      }
      /*timeWebSocket.send(
        JSON.stringify({ isFirstBeat: message.data.isFirstBeat })
      );*/
      beatLogger.scrollTo(0, beatLogger.scrollHeight);
    };
    api.playPause();
  } else if (e.target.classList.contains("fa-pause")) {
    //Stop the device
    sendValueToBleDevices(0);
    api.playPause();
    noteLogger.innerHTML = "";
    beatLogger.innerHTML = "";
    metronomeWorker.terminate();
  }
};
stop.onclick = (e) => {
  if (e.target.classList.contains("disabled")) {
    return;
  }
  if (metronomeWorker) {
    // Aggiunto controllo per sicurezza
    metronomeWorker.terminate();
    metronomeWorker = null; // Resetta per la prossima pressione di play
  }
  noteLogger.innerHTML = "";
  beatLogger.innerHTML = "";
  api.stop();
  sendValueToBleDevices(0); 
};
api.playerReady.on(() => {
  playPause.classList.remove("disabled");
  stop.classList.remove("disabled");
});
api.playerStateChanged.on((e) => {
  const icon = playPause.querySelector("i.fas");
  if (e.state === alphaTab.synth.PlayerState.Playing) {
    icon.classList.remove("fa-play");
    icon.classList.add("fa-pause");
  } else {
    icon.classList.remove("fa-pause");
    icon.classList.add("fa-play");
  }
});

// song position
function formatDuration(milliseconds) {
  let seconds = milliseconds / 1000;
  const minutes = (seconds / 60) | 0;
  seconds = (seconds - minutes * 60) | 0;
  return (
    String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0")
  );
}

const songPosition = wrapper.querySelector(".at-song-position");
let previousTime = -1;
api.playerPositionChanged.on((e) => {
  // reduce number of UI updates to second changes.
  const currentSeconds = (e.currentTime / 1000) | 0;
  if (currentSeconds == previousTime) {
    return;
  }

  songPosition.innerText =
    formatDuration(e.currentTime) + " / " + formatDuration(e.endTime);
});

api.activeBeatsChanged.on((args) => {
  noteLogger.innerHTML = ""; 
  if (args.activeBeats.length > 0 && args.activeBeats[0].noteValueLookup.size > 0) {
    const currentNotes = Array.from(args.activeBeats[0].noteValueLookup.keys());
    const duration = args.activeBeats[0].duration; // Prendi la durata dal primo beat attivo
    for (let i = 0; i < currentNotes.length; i++) {
        noteLogger.innerHTML += '<p style="text-align: center;">Note ' + currentNotes[i] + " (" + duration + ")</p>";
    }
  }
  noteLogger.scrollTo(0, noteLogger.scrollHeight);
  // Fine logica UI per noteLogger

  let valueToPlay; // Questa variabile conterrà la frequenza della nota da suonare, o 0 per fermare.

  if (args.activeBeats.length > 0 && args.activeBeats[0].noteValueLookup.size > 0) {
    const noteValues = Array.from(args.activeBeats[0].noteValueLookup.keys());
    
    
    if (typeof noteValues[0] === 'number' && !isNaN(noteValues[0])) {
      valueToPlay = convertMidiToFrequency(noteValues[0]);
      // Controlla se convertMidiToFrequency ha restituito un numero valido
      if (typeof valueToPlay !== 'number' || isNaN(valueToPlay)) {
        console.warn("DEBUG: Frequenza non valida da convertMidiToFrequency per MIDI:", noteValues[0], ". Imposto STOP (0).");
        valueToPlay = 0; // Default a 0 (STOP) se la conversione fallisce o restituisce NaN
      }
    } else {
      // Questo caso (noteValues[0] non è un numero valido) dovrebbe essere raro se .size > 0,
      // ma per sicurezza impostiamo a STOP.
      console.warn("DEBUG: noteValues[0] non è un numero valido:", noteValues[0], ". Imposto STOP (0).");
      valueToPlay = 0;
    }
  } else {
    // Non ci sono note attive in questo "beat", quindi inviamo un comando di STOP (0).
    valueToPlay = 0;
  }

  // --- Logica di Throttling e Invio ---
  const now = Date.now();

  // Invia il comando solo se valueToPlay è un numero valido (frequenza o 0)
  if (typeof valueToPlay === 'number' && !isNaN(valueToPlay)) {
    
    // Caso 1: È un comando di STOP (0) per le note
    if (valueToPlay === 0) {
      if (lastSentNoteValue !== 0) { // Invia STOP solo se l'ultima nota inviata non era già uno STOP
        // console.log("DEBUG: Invio comando STOP NOTE (0) via BLE.");
        sendValueToBleDevices(0); // Chiama la tua funzione unificata per inviare 0
        lastSentNoteValue = 0;      // Aggiorna l'ultima nota inviata
        lastNoteSentTimestamp = now; // Aggiorna anche il timestamp per gli STOP
      } else {
        // console.log("DEBUG: Nota già su STOP (0), non invio di nuovo.");
      }
    }
    // Caso 2: È una frequenza di nota (quindi valueToPlay > 0, perché valueToPlay === 1 è per i beat)
    else if (valueToPlay > 1) { 
      if (valueToPlay !== lastSentNoteValue) { // È una nota *diversa* dalla precedente?
        if (now - lastNoteSentTimestamp > MIN_NOTE_INTERVAL_MS) { // È trascorso abbastanza tempo?
          // console.log("DEBUG: Invio NUOVA NOTA (" + valueToPlay + ") via BLE.");
          sendValueToBleDevices(valueToPlay);
          lastSentNoteValue = valueToPlay;
          lastNoteSentTimestamp = now;
        } else {
          console.log("LOG THROTTLE: NUOVA Nota (" + valueToPlay + ") saltata da throttle JS. Intervallo: " + (now - lastNoteSentTimestamp) + "ms. Min richiesto: " + MIN_NOTE_INTERVAL_MS + "ms.");
        }
      } else {
        // console.log("DEBUG: Stessa nota (" + valueToPlay + ") di prima, non invio di nuovo.");
      }
    }
    // Non gestiamo valueToPlay === 1 qui, perché si presume che activeBeatsChanged
    // riguardi solo note musicali (frequenze) o lo stop delle note (0).
    // Il valore 1 per i beat è gestito da metronomeWorker.onmessage.

  } else {
    console.warn("DEBUG: activeBeatsChanged - Tentativo di inviare un valore non numerico/NaN per la nota, saltato. Valore originale:", valueToPlay);
  }
});
