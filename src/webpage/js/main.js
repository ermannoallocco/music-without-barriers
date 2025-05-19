//dajeee
// load elements
const wrapper = document.querySelector(".at-wrap");
const main = wrapper.querySelector(".at-main");
const urlParams = new URLSearchParams(window.location.search);
const urlFileName = urlParams.get("filename");
let connectedBleDevices = new Map();

if (!"WebSocket" in window) {
  alert(
    "WebSocket is NOT supported by your Browser so you cannot use external devices!"
  );
}
var timeWebSocket = new WebSocket("ws://localhost:8080/time");
var notesWebSocket = new WebSocket("ws://localhost:8080/notes");
timeWebSocket.onclose = function () {
  alert("Can't connect to external devices!");
};
notesWebSocket.onclose = function () {
  alert("Can't connect to external devices!");
};

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

//DEVE DIVENTARE UN ARRAY
//writeNotesCharacteristic writeOnCharacteristics inviare a tutti i dispositivi
//disconnectDevice

const deviceName = "ESP32"; // Meglio usare const se non cambiano
const bleService = "19b10000-e8f2-537e-4f6c-d104768a1214";
const vibrationCharacteristicUUID = "19b10002-e8f2-537e-4f6c-d104768a1214"; // Nome aggiornato
const notesCharacteristicUUID = "39114440-f153-414b-9ca8-cd739acad81c"; // Nome aggiornato

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
  let deviceInstance; // Per mantenere il riferimento al device durante la catena di promise

  navigator.bluetooth
    .requestDevice({
      filters: [{ name: deviceName }],
      optionalServices: [bleService],
    })
    .then((device) => {
      deviceInstance = device;
      console.log(
        "Dispositivo selezionato:",
        deviceInstance.name,
        "(ID:",
        deviceInstance.id,
        ")"
      );

      if (
        connectedBleDevices.has(deviceInstance.id) &&
        connectedBleDevices.get(deviceInstance.id).connected
      ) {
        console.warn(
          "Il dispositivo",
          deviceInstance.name,
          "risulta già connesso e presente nella lista. Operazione annullata."
        );
        throw new Error("Dispositivo già connesso.");
      }

      deviceInstance.addEventListener("gattserverdisconnected", onDisconnected);
      console.log(
        "Tentativo di connessione al GATT server per:",
        deviceInstance.name
      );
      return deviceInstance.gatt.connect();
    })
    .then((gattServer) => {
      console.log("Connesso al GATT Server per:", deviceInstance.name);
      console.log("Tentativo di ottenere il servizio primario:", bleService);
      return gattServer.getPrimaryService(bleService);
    })
    .then((service) => {
      console.log(
        "Servizio primario trovato per:",
        deviceInstance.name,
        "UUID:",
        service.uuid
      );
      console.log(
        "Tentativo di ottenere le caratteristiche Vibrazione e Note."
      );
      return Promise.all([
        service.getCharacteristic(vibrationCharacteristicUUID),
        service.getCharacteristic(notesCharacteristicUUID),
        Promise.resolve(service),
        Promise.resolve(deviceInstance.gatt),
      ]);
    })
    .then(
      ([
        vibrationCharInstance,
        notesCharInstance,
        serviceInstance,
        gattServerInstance,
      ]) => {
        console.log("Caratteristiche scoperte per:", deviceInstance.name);
        console.log("  Vibrazione Char UUID:", vibrationCharInstance.uuid);
        console.log("  Note Char UUID:", notesCharInstance.uuid);

        const deviceInfo = {
          id: deviceInstance.id,
          name: deviceInstance.name,
          server: gattServerInstance,
          service: serviceInstance,
          vibrationChar: vibrationCharInstance,
          notesChar: notesCharInstance,
          connected: true,
          isWritingToVibration: false, // NUOVO FLAG
          isWritingToNotes: false, // NUOVO FLAG
        };

        connectedBleDevices.set(deviceInstance.id, deviceInfo);

        console.log(
          "Dispositivo aggiunto alla lista:",
          deviceInfo.name,
          ". Dispositivi totali:",
          connectedBleDevices.size
        );
        console.log("Mappa dei dispositivi connessi:", connectedBleDevices);
      }
    )
    .catch((error) => {
      if (error.message === "Dispositivo già connesso.") {
        return;
      }
      console.error(
        "Errore durante il processo di connessione Bluetooth per " +
          (deviceInstance ? deviceInstance.name : "un dispositivo") +
          ":",
        error
      );
      if (deviceInstance) {
        deviceInstance.removeEventListener(
          "gattserverdisconnected",
          onDisconnected
        );
      }
    });
}

/**
 * Gestisce l'evento di disconnessione imprevista di un dispositivo.
 * @param {Event} event - L'evento di disconnessione.
 */
function onDisconnected(event) {
  const disconnectedDevice = event.target;
  console.warn(
    "DISCONNESSO: Il dispositivo",
    disconnectedDevice.name,
    "(ID:",
    disconnectedDevice.id,
    ") si è disconnesso inaspettatamente."
  );

  if (connectedBleDevices.has(disconnectedDevice.id)) {
    const deviceInfo = connectedBleDevices.get(disconnectedDevice.id);
    deviceInfo.connected = false;
    deviceInfo.isWritingToVibration = false; // Resetta i flag in caso di disconnessione
    deviceInfo.isWritingToNotes = false; // Resetta i flag in caso di disconnessione
    console.log(
      "Stato del dispositivo",
      disconnectedDevice.name,
      "impostato su non connesso. Dispositivi ancora in mappa:",
      connectedBleDevices.size
    );
  }

  let stillConnectedCount = 0;
  connectedBleDevices.forEach((dev) => {
    if (dev.connected) stillConnectedCount++;
  });
  if (
    stillConnectedCount === 0 &&
    typeof api !== "undefined" &&
    api &&
    api.playerState === alphaTab.synth.PlayerState.Playing
  ) {
    console.log(
      "Tutti i dispositivi sono disconnessi. Messa in pausa della riproduzione."
    );
    if (typeof metronomeWorker !== "undefined" && metronomeWorker) {
      metronomeWorker.terminate();
      metronomeWorker = null;
    }
    api.playPause();
    if (typeof noteLogger !== "undefined" && noteLogger)
      noteLogger.innerHTML = "";
    if (typeof beatLogger !== "undefined" && beatLogger)
      beatLogger.innerHTML = "";
  }
}

/**
 * Disconnette tutti i dispositivi BLE attualmente connessi e pulisce lo stato.
 */
function disconnectDevice() {
  console.log("Tentativo di disconnettere tutti i dispositivi...");

  if (!connectedBleDevices || connectedBleDevices.size === 0) {
    console.warn(
      "Nessun dispositivo BLE attualmente connesso o mappato da disconnettere."
    );
  }

  let allDisconnectedSuccessfully = true;

  connectedBleDevices.forEach((deviceInfo, deviceId) => {
    // Resetta i flag di scrittura prima di tentare la disconnessione
    deviceInfo.isWritingToVibration = false;
    deviceInfo.isWritingToNotes = false;

    if (deviceInfo.server && deviceInfo.server.connected) {
      console.log(
        "Disconnessione del dispositivo:",
        deviceInfo.name,
        "(ID:",
        deviceId,
        ")"
      );
      try {
        deviceInfo.server.disconnect();
        console.log("Comando di disconnessione inviato a", deviceInfo.name);
      } catch (error) {
        allDisconnectedSuccessfully = false;
        console.error(
          "Errore durante il tentativo di disconnessione di",
          deviceInfo.name,
          ":",
          error
        );
      }
    } else {
      deviceInfo.connected = false; // Assicura che sia marcato come non connesso
    }
  });

  connectedBleDevices.clear();
  console.log(
    "Mappa dei dispositivi connessi svuotata. Dispositivi connessi:",
    connectedBleDevices.size
  );

  if (
    typeof api !== "undefined" &&
    api &&
    typeof api.playPause === "function" &&
    api.playerState === alphaTab.synth.PlayerState.Playing
  ) {
    console.log("Messa in pausa della riproduzione di AlphaTab.");
    api.playPause();
  }
  if (typeof noteLogger !== "undefined" && noteLogger) {
    noteLogger.innerHTML = "";
  }
  if (typeof beatLogger !== "undefined" && beatLogger) {
    beatLogger.innerHTML = "";
  }
  if (typeof metronomeWorker !== "undefined" && metronomeWorker) {
    console.log("Terminazione del metronomeWorker.");
    metronomeWorker.terminate();
    metronomeWorker = null;
  }

  if (allDisconnectedSuccessfully) {
    console.log("Comandi di disconnessione inviati a tutti i dispositivi.");
  } else {
    console.warn(
      "Alcuni dispositivi potrebbero non essersi disconnessi correttamente o erano già disconnessi. Controllare i log."
    );
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

//Write writeValueToBleDevices
function writeValueToBleDevices(value) {
  if (!connectedBleDevices || connectedBleDevices.size === 0) {
    // Non mostrare un avviso qui se non è strettamente un errore,
    // potrebbe essere normale non avere dispositivi connessi a volte.
    // console.warn("Nessun dispositivo BLE connesso. Impossibile scrivere il valore.");
    return;
  }

  const data = new Uint16Array([value]);

  console.log(
    // Questo log potrebbe essere troppo verboso se chiamato frequentemente
    "Tentativo di scrivere il valore: " +
      value +
      " (Uint16: " +
      data[0] +
      ") ai dispositivi (" +
      connectedBleDevices.size +
      ")."
  );

  connectedBleDevices.forEach((deviceInfo, deviceId) => {
    if (!deviceInfo.connected) {
      console.warn(
        "Dispositivo " +
          deviceInfo.name +
          " (ID: " +
          deviceId +
          ") non connesso. Scrittura saltata."
      );
      return;
    }

    // Caso 1: value è 0 (STOP per entrambi: vibrazione e note)
    if (value === 0) {
      // Invia 0 alla caratteristica Vibrazione
      if (deviceInfo.vibrationChar) {
        if (deviceInfo.isWritingToVibration) {
          console.warn(
            "Vibration char per " +
              deviceInfo.name +
              " occupata. Valore STOP (0) saltato."
          );
        } else {
          deviceInfo.isWritingToVibration = true;
          deviceInfo.vibrationChar
            .writeValueWithResponse(data)
            .then(() => {
              console.log(
                "Valore STOP (0) inviato a Vibrazione di: " + deviceInfo.name
              );
            })
            .catch((error) => {
              console.error(
                "Errore scrittura STOP (0) su Vibrazione per " +
                  deviceInfo.name +
                  ": ",
                error
              );
              if (
                error.name === "NetworkError" ||
                (error.message &&
                  error.message.includes("GATT Server is disconnected"))
              ) {
                deviceInfo.connected = false; // Segna come disconnesso in caso di errore grave
                console.warn(
                  "Dispositivo " +
                    deviceInfo.name +
                    " (Vibrazione) marcato come disconnesso a causa di errore."
                );
              }
            })
            .finally(() => {
              deviceInfo.isWritingToVibration = false;
            });
        }
      } else {
        console.warn(
          "Caratteristica Vibrazione non trovata per " + deviceInfo.name
        );
      }

      // Invia 0 alla caratteristica Note
      if (deviceInfo.notesChar) {
        if (deviceInfo.isWritingToNotes) {
          console.warn(
            "Notes char per " +
              deviceInfo.name +
              " occupata. Valore STOP (0) saltato."
          );
        } else {
          deviceInfo.isWritingToNotes = true;
          deviceInfo.notesChar
            .writeValueWithResponse(data)
            .then(() => {
              console.log(
                "Valore STOP (0) inviato a Note di: " + deviceInfo.name
              );
            })
            .catch((error) => {
              console.error(
                "Errore scrittura STOP (0) su Note per " +
                  deviceInfo.name +
                  ": ",
                error
              );
              if (
                error.name === "NetworkError" ||
                (error.message &&
                  error.message.includes("GATT Server is disconnected"))
              ) {
                deviceInfo.connected = false; // Segna come disconnesso
                console.warn(
                  "Dispositivo " +
                    deviceInfo.name +
                    " (Note) marcato come disconnesso a causa di errore."
                );
              }
            })
            .finally(() => {
              deviceInfo.isWritingToNotes = false;
            });
        }
      } else {
        console.warn("Caratteristica Note non trovata per " + deviceInfo.name);
      }
    }
    // Caso 2: value è 1 (segnale per la Vibrazione)
    else if (value === 1) {
      if (deviceInfo.vibrationChar) {
        if (deviceInfo.isWritingToVibration) {
          console.warn(
            "Vibration char per " +
              deviceInfo.name +
              " occupata. Valore BEAT (1) saltato."
          );
        } else {
          deviceInfo.isWritingToVibration = true;
          deviceInfo.vibrationChar
            .writeValueWithResponse(data)
            .then(() => {
              console.log(
                "Valore BEAT/VIBRAZIONE (1) inviato a Vibrazione di: " +
                  deviceInfo.name
              );
            })
            .catch((error) => {
              console.error(
                "Errore scrittura BEAT/VIBRAZIONE (1) su Vibrazione per " +
                  deviceInfo.name +
                  ": ",
                error
              );
              if (
                error.name === "NetworkError" ||
                (error.message &&
                  error.message.includes("GATT Server is disconnected"))
              ) {
                deviceInfo.connected = false; // Segna come disconnesso
                console.warn(
                  "Dispositivo " +
                    deviceInfo.name +
                    " (Vibrazione) marcato come disconnesso a causa di errore."
                );
              }
            })
            .finally(() => {
              deviceInfo.isWritingToVibration = false;
            });
        }
      } else {
        console.warn(
          "Caratteristica Vibrazione non trovata per " + deviceInfo.name
        );
      }
    }
    // Caso 3: value è una frequenza per le Note (qualsiasi altro numero diverso da 0 o 1)
    else {
      if (deviceInfo.notesChar) {
        if (deviceInfo.isWritingToNotes) {
          console.warn(
            "Notes char per " +
              deviceInfo.name +
              " occupata. Valore FREQUENZA (" +
              value +
              ") saltato."
          );
        } else {
          deviceInfo.isWritingToNotes = true;
          deviceInfo.notesChar
            .writeValueWithResponse(data)
            .then(() => {
              console.log(
                "Valore FREQUENZA (" +
                  value +
                  ") inviato a Note di: " +
                  deviceInfo.name
              );
            })
            .catch((error) => {
              console.error(
                "Errore scrittura FREQUENZA (" +
                  value +
                  ") su Note per " +
                  deviceInfo.name +
                  ": ",
                error
              );
              if (
                error.name === "NetworkError" ||
                (error.message &&
                  error.message.includes("GATT Server is disconnected"))
              ) {
                deviceInfo.connected = false; // Segna come disconnesso
                console.warn(
                  "Dispositivo " +
                    deviceInfo.name +
                    " (Note) marcato come disconnesso a causa di errore: " +
                    error.message
                );
              }
            })
            .finally(() => {
              deviceInfo.isWritingToNotes = false;
            });
        }
      } else {
        console.warn("Caratteristica Note non trovata per " + deviceInfo.name);
      }
    }
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
      if (timeWebSocket.readyState != 1) return;
      if (message.data.isFirstBeat) {
        beatLogger.innerHTML = '<p style="color: green;">BEAT</p>';
        //Send beat to the device
        writeValueToBleDevices(1);
        highlightBeat("green");
      } else {
        beatLogger.innerHTML += '<p style="color: red;">BEAT</p>';
        //Send beat to the device
        writeValueToBleDevices(1);
        highlightBeat("red");
      }
      timeWebSocket.send(
        JSON.stringify({ isFirstBeat: message.data.isFirstBeat })
      );
      beatLogger.scrollTo(0, beatLogger.scrollHeight);
    };
    api.playPause();
  } else if (e.target.classList.contains("fa-pause")) {
    //Stop the device
    writeValueToBleDevices(0);
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
  writeValueToBleDevices(0); // <<< AGGIUNGI QUESTA RIGA
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
  for (let index = 0; index < args.activeBeats.length; index++) {
    const duration = args.activeBeats[index].duration;
    const noteValues = Array.from(
      args.activeBeats[index].noteValueLookup.keys()
    );

    //Convert midi to frequency
    if (index == 0) {
      let temp = convertMidiToFrequency(noteValues[0]);
      //Send note to the device
      writeValueToBleDevices(temp);
    }

    let i = 0;
    for (i = 0; i < noteValues.length; i++) {
      noteLogger.innerHTML +=
        '<p style="text-align: center;">Note ' +
        noteValues[i] +
        " (" +
        duration +
        ")</p>";
    }
    noteLogger.scrollTo(0, noteLogger.scrollHeight);
  }
  if (notesWebSocket.readyState != 1) return;
  notesWebSocket.send(JSON.stringify({ data: noteLogger.innerHTML }));
});
