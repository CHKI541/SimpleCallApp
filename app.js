// Simple Call App - Web Application logic

// Configuración de Firebase (Extraída de google-services.json del proyecto Android)
const firebaseConfig = {
    apiKey: "AIzaSyAb3dF0OBwknGFxEezknHbMAJZ6WbG5njo",
    authDomain: "app-de-llamada.firebaseapp.com",
    projectId: "app-de-llamada",
    storageBucket: "app-de-llamada.firebasestorage.app",
    messagingSenderId: "717516447001",
    appId: "1:717516447001:web:db3864f772cd015822384a" // ID ficticio web compatible
};

// Inicializar Firebase
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// Variables globales de estado
let currentUser = null;
let myNumber = "";
let myName = "";
let activeChatNumber = "";
let activeChatName = "";

// WebRTC & Llamadas
let localStream = null;
let peerConnection = null;
let callTimer = null;
let callDurationSeconds = 0;
let isMuted = false;
let currentCallNumber = "";
let isIncomingCall = false;

// Listeners activos en Firestore (para desmontar cuando corresponda)
let incomingCallListener = null;
let chatMessagesListener = null;
let chatsListListener = null;
let contactsListener = null;
let historyListener = null;
let callSessionListener = null; // listener activo de sesión de llamada en curso
const individualChatListeners = {}; // roomId -> listener

const peerConfig = {
    iceServers: [
        { urls: "stun:openrelay.metered.ca:80" },
        { 
            urls: "turn:openrelay.metered.ca:80?transport=udp", 
            username: "openrelayproject", 
            credential: "openrelayproject" 
        },
        { 
            urls: "turn:openrelay.metered.ca:443?transport=tcp", 
            username: "openrelayproject", 
            credential: "openrelayproject" 
        },
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" }
    ],
    sdpSemantics: "unified-plan"
};

// Función helper para prevenir vulnerabilidades de XSS (Cross-Site Scripting) al inyectar HTML
function escapeHTML(str) {
    if (!str) return "";
    return str.toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Elementos de Audio en el DOM
const ringtoneAudio = document.getElementById("audio-ringtone");
const notificationAudio = document.getElementById("audio-notification");
const remoteAudio = document.getElementById("remote-audio");

// --- INICIALIZACIÓN ---
document.addEventListener("DOMContentLoaded", () => {
    // Suscribirse a cambios en el estado de autenticación
    auth.onAuthStateChanged(user => {
        if (user) {
            currentUser = user;
            reloadUserAndVerify();
        } else {
            currentUser = null;
            myNumber = "";
            myName = "";
            showView("login-container");
            cleanupListeners();
        }
    });

    setupUIListeners();
    setupDialer();
    checkNotificationPermission();
});

// --- AUTENTICACIÓN Y VALIDACIONES ---

function reloadUserAndVerify() {
    showLoader(true, "Verificando sesión...");
    
    // Forzar recarga de usuario para validar estado
    currentUser.reload().then(() => {
        if (true || currentUser.emailVerified) {
            // Verificar si tiene perfil creado en Firestore
            db.collection("users").document ? "" : ""; // Compat API: db.collection().doc()
            db.collection("users").doc(currentUser.uid).get()
                .then(doc => {
                    if (doc.exists) {
                        const userData = doc.data();
                        if (userData.number) {
                            myNumber = userData.number;
                            myName = userData.name || "Usuario";
                            
                            // Guardar en almacenamiento local
                            localStorage.setItem("user_number", myNumber);
                            
                            // Entrar al Dashboard
                            setupDashboardUI();
                            startGlobalListeners();
                            showView("dashboard-container");
                        } else {
                            // Tiene perfil pero no asignó número
                            showView("number-container");
                        }
                    } else {
                        // Perfil nuevo
                        showView("number-container");
                    }
                })
                .catch(err => {
                    alert("Error al cargar perfil: " + err.message);
                    auth.signOut();
                });
        } else {
            // No verificado
            showView("verification-container");
        }
    }).catch(err => {
        // Error de conexión o sesión expirada
        showView("login-container");
    });
}

function setupDashboardUI() {
    document.getElementById("user-display-name").innerText = myName;
    document.getElementById("user-display-number").innerText = "Número: " + myNumber;
    document.getElementById("user-avatar-char").innerText = myName.charAt(0).toUpperCase();
    document.getElementById("settings-name").value = myName;
    showLoader(false);
}

// Iniciar escuchas globales (llamadas entrantes, mensajes)
function startGlobalListeners() {
    cleanupListeners();

    // 1. Escuchar llamadas VoIP dirigidas a mí
    incomingCallListener = db.collection("calls").doc(myNumber)
        .onSnapshot(doc => {
            if (doc.exists) {
                const callSession = doc.data();
                if (callSession.status === "ringing" && callSession.callerNumber !== myNumber) {
                    // Si ya estoy en una llamada, ignorar/rechazar
                    if (peerConnection) {
                        db.collection("calls").doc(myNumber).update({ status: "ended" });
                        return;
                    }
                    showIncomingCallPopup(callSession.callerNumber);
                } else if (callSession.status === "ended" || callSession.status === "rejected") {
                    // El caller terminó la llamada — el callee debe terminarla también
                    hideIncomingCallPopup();
                    if (peerConnection) {
                        endCallLocally();
                    }
                }
            } else {
                // El documento fue eliminado (caller limpió la sesión)
                hideIncomingCallPopup();
                if (isIncomingCall && peerConnection) {
                    endCallLocally();
                }
            }
        });

    // 2. Escuchar mensajes nuevos para notificaciones
    listenMessagesForNotifications();
}

// Escuchar los mensajes no leídos de los chats activos del usuario
function listenMessagesForNotifications() {
    // Escuchar salas de chat del usuario
    chatsListListener = db.collection("chats")
        .where("participants", "array-contains", myNumber)
        .onSnapshot(snapshot => {
            if (snapshot) {
                const currentRoomIds = snapshot.docs.map(doc => doc.id);
                
                // Desmontar salas inactivas
                for (const roomId in individualChatListeners) {
                    if (!currentRoomIds.includes(roomId)) {
                        individualChatListeners[roomId]();
                        delete individualChatListeners[roomId];
                    }
                }

                // Agregar listeners individuales
                snapshot.docs.forEach(doc => {
                    const roomId = doc.id;
                    if (!individualChatListeners[roomId]) {
                        individualChatListeners[roomId] = db.collection("chats").doc(roomId)
                            .collection("messages")
                            .where("toNumber", "==", myNumber)
                            .where("delivered", "==", false)
                            .onSnapshot(msgSnapshot => {
                                if (msgSnapshot) {
                                    const isMsgNotifEnabled = document.getElementById("settings-toggle-msg-notif").checked;
                                    
                                    msgSnapshot.docChanges().forEach(change => {
                                        if (change.type === "added") {
                                            const msg = change.doc.data();
                                            if (msg.id && msg.fromNumber !== myNumber) {
                                                // Marcar como entregado en Firestore
                                                db.collection("chats").doc(roomId)
                                                    .collection("messages").doc(msg.id)
                                                    .update({ delivered: true });

                                                // Si el chat no está abierto, mostrar notificación
                                                if (activeChatNumber !== msg.fromNumber) {
                                                    if (isMsgNotifEnabled) {
                                                        playNotificationSound();
                                                        showDesktopNotification("Mensaje de " + msg.fromNumber, msg.text, msg.fromNumber);
                                                    }
                                                    // Refrescar chats list
                                                    loadChatsList();
                                                }
                                            }
                                        }
                                    });
                                }
                            });
                    }
                });
            }
        });
}

function cleanupListeners() {
    if (incomingCallListener) incomingCallListener();
    if (chatsListListener) chatsListListener();
    if (chatMessagesListener) chatMessagesListener();
    if (contactsListener) contactsListener();
    if (historyListener) historyListener();
    
    for (const roomId in individualChatListeners) {
        individualChatListeners[roomId]();
    }
    
    incomingCallListener = null;
    chatsListListener = null;
    chatMessagesListener = null;
    contactsListener = null;
    historyListener = null;
}

// --- ACCIONES UI DE BOTONES ---

function setupUIListeners() {
    // Botones Login & Registro
    document.getElementById("btn-login").addEventListener("click", loginWithEmail);
    document.getElementById("btn-register").addEventListener("click", registerWithEmail);
    document.getElementById("btn-forgot-password").addEventListener("click", sendPasswordReset);
    document.getElementById("btn-save-number").addEventListener("click", saveNumberProfile);
    
    // Verificación
    document.getElementById("btn-check-verified").addEventListener("click", reloadUserAndVerify);
    document.getElementById("btn-resend-verification").addEventListener("click", resendEmailVerification);
    document.getElementById("btn-cancel-verification").addEventListener("click", () => {
        auth.signOut();
        document.getElementById("verification-container").style.display = "none";
    });

    // Pestañas del sidebar
    const tabs = document.querySelectorAll(".nav-tab");
    tabs.forEach(tab => {
        tab.addEventListener("click", () => {
            tabs.forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
            
            const tabId = tab.getAttribute("data-tab");
            const panels = document.querySelectorAll(".tab-panel");
            panels.forEach(p => p.classList.remove("active"));
            document.getElementById(tabId).classList.add("active");
            
            // Cargar datos correspondientes al panel activo
            if (tabId === "tab-chats") loadChatsList();
            if (tabId === "tab-contacts") loadContactsList();
            if (tabId === "tab-history") loadCallHistoryList();
        });
    });

    // Perfil
    document.getElementById("btn-update-name").addEventListener("click", updateProfileName);
    document.getElementById("btn-change-password-dialog").addEventListener("click", () => {
        document.getElementById("modal-change-password").style.display = "flex";
    });
    document.getElementById("btn-close-pass-dialog").addEventListener("click", () => {
        document.getElementById("modal-change-password").style.display = "none";
    });
    document.getElementById("btn-save-new-password").addEventListener("click", changePassword);
    document.getElementById("btn-sign-out").addEventListener("click", () => auth.signOut());

    // Crear contacto
    document.getElementById("btn-new-contact-dialog").addEventListener("click", () => {
        document.getElementById("modal-new-contact").style.display = "flex";
    });
    document.getElementById("btn-close-contact-dialog").addEventListener("click", () => {
        document.getElementById("modal-new-contact").style.display = "none";
    });
    document.getElementById("btn-save-new-contact").addEventListener("click", addContact);

    // Iniciar Chat
    document.getElementById("btn-new-chat-dialog").addEventListener("click", () => {
        document.getElementById("modal-new-chat").style.display = "flex";
    });
    document.getElementById("btn-close-chat-dialog").addEventListener("click", () => {
        document.getElementById("modal-new-chat").style.display = "none";
    });
    document.getElementById("btn-start-new-chat").addEventListener("click", startNewChat);

    // Borrar historial
    document.getElementById("btn-clear-history-confirm").addEventListener("click", clearCallHistory);

    // Chat activo e inputs
    document.getElementById("btn-chat-send").addEventListener("click", sendChatMessage);
    document.getElementById("chat-message-input").addEventListener("keypress", (e) => {
        if (e.key === "Enter") sendChatMessage();
    });

    // Llamadas desde cabecera de chat
    document.getElementById("btn-chat-call-voip").addEventListener("click", () => {
        initiateVoipCall(activeChatNumber);
    });

    // Controles de llamada activa
    document.getElementById("btn-call-hangup").addEventListener("click", rejectOrHangupCall);
    document.getElementById("btn-call-mute").addEventListener("click", toggleCallMute);
    document.getElementById("btn-call-speaker").addEventListener("click", toggleCallSpeaker);

    // Alertas de llamada entrante popup
    document.getElementById("btn-incoming-accept").addEventListener("click", acceptIncomingCall);
    document.getElementById("btn-incoming-reject").addEventListener("click", rejectIncomingCall);

    // Banner de notificaciones
    document.getElementById("btn-enable-notif").addEventListener("click", requestNotificationPermission);
    document.getElementById("btn-close-banner").addEventListener("click", () => {
        document.getElementById("notif-banner").style.display = "none";
    });
}

// --- FUNCIONES DE AUTENTICACIÓN ---

function loginWithEmail() {
    const email = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value.trim();
    if (!email || !password) return alert("Completa todos los campos");
    
    showLoader(true, "Iniciando sesión...");
    auth.signInWithEmailAndPassword(email, password)
        .catch(err => {
            showLoader(false);
            alert("Error: " + err.message);
        });
}

function registerWithEmail() {
    const email = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value.trim();
    if (!email || !password) return alert("Completa todos los campos");
    if (password.length < 6) return alert("La contraseña debe tener al menos 6 caracteres");

    showLoader(true, "Registrando usuario...");
    auth.createUserWithEmailAndPassword(email, password)
        .then(result => {
            // Enviar verificación
            result.user.sendEmailVerification();
            
            // Crear perfil inicial en Firestore
            db.collection("users").doc(result.user.uid).set({
                uid: result.user.uid,
                email: email,
                name: "",
                number: "",
                status: "offline"
            });
            showView("verification-container");
        })
        .catch(err => {
            showLoader(false);
            alert("Error al registrarse: " + err.message);
        });
}

function sendPasswordReset() {
    const email = document.getElementById("auth-email").value.trim();
    if (!email) return alert("Ingresa tu correo primero en el campo de texto");
    
    auth.sendPasswordResetEmail(email)
        .then(() => alert("✅ Correo de reseteo enviado exitosamente a " + email))
        .catch(err => alert("Error: " + err.message));
}

function saveNumberProfile() {
    const name = document.getElementById("profile-name").value.trim();
    const number = document.getElementById("profile-number").value.trim();
    if (!name || !number) return alert("Ingresa tu nombre y el número deseado");

    showLoader(true, "Guardando número...");

    // Verificar si el número ya está tomado
    db.collection("users").where("number", "==", number).get()
        .then(snapshot => {
            if (!snapshot.empty) {
                showLoader(false);
                return alert("El número ya está registrado por otro usuario");
            }

            // Guardar perfil
            db.collection("users").doc(currentUser.uid).set({
                uid: currentUser.uid,
                email: currentUser.email,
                name: name,
                number: number,
                status: "online"
            }, { merge: true }).then(() => {
                myNumber = number;
                myName = name;
                localStorage.setItem("user_number", myNumber);
                setupDashboardUI();
                startGlobalListeners();
                showView("dashboard-container");
            });
        })
        .catch(err => {
            showLoader(false);
            alert("Error: " + err.message);
        });
}

function resendEmailVerification() {
    if (currentUser) {
        currentUser.sendEmailVerification()
            .then(() => alert("Correo de verificación reenviado"))
            .catch(err => alert("Error: " + err.message));
    }
}

function updateProfileName() {
    const newName = document.getElementById("settings-name").value.trim();
    if (!newName) return alert("El nombre no puede estar vacío");

    db.collection("users").doc(currentUser.uid).update({ name: newName })
        .then(() => {
            myName = newName;
            document.getElementById("user-display-name").innerText = myName;
            document.getElementById("user-avatar-char").innerText = myName.charAt(0).toUpperCase();
            alert("Perfil actualizado correctamente");
        })
        .catch(err => alert("Error: " + err.message));
}

function changePassword() {
    const newPass = document.getElementById("new-password-input").value.trim();
    if (newPass.length < 6) return alert("La contraseña debe tener al menos 6 caracteres");

    currentUser.updatePassword(newPass)
        .then(() => {
            document.getElementById("modal-change-password").style.display = "none";
            document.getElementById("new-password-input").value = "";
            alert("Contraseña actualizada exitosamente");
        })
        .catch(err => alert("Error al actualizar contraseña: " + err.message));
}

// --- GESTIÓN DE CONTACTOS ---

function loadContactsList() {
    const listContainer = document.getElementById("contacts-list");
    listContainer.innerHTML = '<div class="text-center p-4">Cargando contactos...</div>';

    contactsListener = db.collection("users").doc(currentUser.uid)
        .collection("contacts")
        .onSnapshot(snapshot => {
            listContainer.innerHTML = "";
            if (!snapshot || snapshot.empty) {
                listContainer.innerHTML = '<div class="empty-state"><h4>No tienes contactos guardados</h4></div>';
                return;
            }

            snapshot.docs.forEach(doc => {
                const contact = doc.data();
                const item = document.createElement("div");
                item.className = "list-item";
                
                const nameEscaped = escapeHTML(contact.name);
                const numberEscaped = escapeHTML(contact.number);
                const avatarChar = nameEscaped.length > 0 ? nameEscaped.charAt(0).toUpperCase() : "?";

                item.innerHTML = `
                    <div class="profile-avatar">${avatarChar}</div>
                    <div class="list-item-info">
                        <div class="list-item-title">${nameEscaped}</div>
                        <div class="list-item-subtitle">Tel: ${numberEscaped}</div>
                    </div>
                    <div class="list-item-actions">
                        <button class="material-icons btn-item-action chat">forum</button>
                        <button class="material-icons btn-item-action call">phone</button>
                        <button class="material-icons btn-item-action delete" style="color: var(--hangup-red);">delete</button>
                    </div>
                `;

                // Asignar listeners programáticamente para evitar inyecciones XSS en atributos onclick
                item.querySelector(".chat").addEventListener("click", () => openDirectChat(contact.number, contact.name));
                item.querySelector(".call").addEventListener("click", () => initiateVoipCall(contact.number));
                item.querySelector(".delete").addEventListener("click", () => deleteContact(contact.id));

                listContainer.appendChild(item);
            });
        });
}

function addContact() {
    const name = document.getElementById("new-contact-name").value.trim();
    const number = document.getElementById("new-contact-number").value.trim();
    if (!name || !number) return alert("Completa todos los campos");

    const contactId = db.collection("users").doc(currentUser.uid).collection("contacts").doc().id;
    db.collection("users").doc(currentUser.uid).collection("contacts").doc(contactId).set({
        id: contactId,
        name: name,
        number: number
    }).then(() => {
        document.getElementById("modal-new-contact").style.display = "none";
        document.getElementById("new-contact-name").value = "";
        document.getElementById("new-contact-number").value = "";
        alert("Contacto agregado");
    }).catch(err => alert("Error: " + err.message));
}

window.deleteContact = function(contactId) {
    if (confirm("¿Estás seguro de eliminar este contacto?")) {
        db.collection("users").doc(currentUser.uid).collection("contacts").doc(contactId).delete()
            .then(() => alert("Contacto eliminado"));
    }
};

// --- GESTIÓN DE CHATS Y MENSAJES ---

function loadChatsList() {
    const listContainer = document.getElementById("chats-list");
    listContainer.innerHTML = '<div class="text-center p-4">Cargando conversaciones...</div>';

    // Cargar contactos locales en un mapa para resolver nombres
    db.collection("users").doc(currentUser.uid).collection("contacts").get()
        .then(contactsSnapshot => {
            const contactMap = {};
            contactsSnapshot.forEach(doc => {
                const c = doc.data();
                contactMap[c.number] = c.name;
            });

            db.collection("chats")
                .where("participants", "array-contains", myNumber)
                .get() // Usamos get para ordenarlo en memoria y evitar requerir índices compuestos
                .then(snapshot => {
                    listContainer.innerHTML = "";
                    if (snapshot.empty) {
                        listContainer.innerHTML = '<div class="empty-state"><h4>No tienes chats abiertos</h4></div>';
                        return;
                    }

                    // Ordenar localmente por lastMessageTimestamp descendente
                    const chatRooms = snapshot.docs.map(doc => doc.data())
                        .sort((a, b) => b.lastMessageTimestamp - a.lastMessageTimestamp);

                    chatRooms.forEach(room => {
                        const otherNumber = room.participants.find(p => p !== myNumber) || myNumber;
                        const otherName = contactMap[otherNumber] || otherNumber;
                        const dateStr = formatTimestamp(room.lastMessageTimestamp);
                        
                        const otherNameEscaped = escapeHTML(otherName);
                        const lastMsgEscaped = room.lastMessageText ? escapeHTML(room.lastMessageText) : "Sin mensajes";
                        const avatarChar = otherNameEscaped.length > 0 ? otherNameEscaped.charAt(0).toUpperCase() : "?";

                        const item = document.createElement("div");
                        item.className = "list-item" + (activeChatNumber === otherNumber ? " active-bg" : "");
                        item.onclick = () => openDirectChat(otherNumber, otherName);
                        
                        item.innerHTML = `
                            <div class="profile-avatar">${avatarChar}</div>
                            <div class="list-item-info">
                                <div class="list-item-header">
                                    <div class="list-item-title">${otherNameEscaped}</div>
                                    <div class="list-item-time">${dateStr}</div>
                                </div>
                                <div class="list-item-subtitle">${lastMsgEscaped}</div>
                            </div>
                        `;
                        listContainer.appendChild(item);
                    });
                });
        });
}

function startNewChat() {
    const target = document.getElementById("new-chat-number").value.trim();
    if (!target) return alert("Ingresa un número");
    if (target === myNumber) return alert("No puedes chatear contigo mismo");

    document.getElementById("modal-new-chat").style.display = "none";
    document.getElementById("new-chat-number").value = "";
    
    openDirectChat(target, target);
}

window.openDirectChat = function(otherNumber, otherName) {
    activeChatNumber = otherNumber;
    activeChatName = otherName;

    // Mostrar el contenedor de chat y ocultar el empty state
    document.getElementById("chat-empty-state").style.display = "none";
    document.getElementById("chat-active-container").style.display = "flex";

    document.getElementById("active-chat-name").innerText = otherName;
    document.getElementById("active-chat-number").innerText = otherNumber;

    // Para responsividad en móviles
    document.body.classList.add("mobile-chat-active");

    // Desmontar listener del chat anterior
    if (chatMessagesListener) chatMessagesListener();

    const roomId = getChatRoomId(myNumber, otherNumber);
    
    // Escuchar mensajes en tiempo real ordenados por timestamp
    chatMessagesListener = db.collection("chats").doc(roomId)
        .collection("messages")
        .orderBy("timestamp", "asc")
        .onSnapshot(snapshot => {
            const container = document.getElementById("chat-messages-scroll");
            container.innerHTML = "";

            if (!snapshot || snapshot.empty) {
                container.innerHTML = '<div class="text-center p-4" style="color: var(--text-light-gray)">No hay mensajes en esta conversación</div>';
                return;
            }

            const readReceiptsEnabled = document.getElementById("settings-toggle-read-receipts").checked;

            snapshot.docs.forEach(doc => {
                const msg = doc.data();
                
                // Marcar como entregados y leídos si es entrante
                if (msg.fromNumber === otherNumber) {
                    const updateData = {};
                    if (!msg.delivered) updateData.delivered = true;
                    if (readReceiptsEnabled && !msg.read) updateData.read = true;
                    
                    if (Object.keys(updateData).length > 0) {
                        db.collection("chats").doc(roomId).collection("messages").doc(msg.id).update(updateData);
                    }
                }

                // Resolver marca de tiempo de forma segura (retrocompatible)
                let msgTime = Date.now();
                if (msg.timestamp) {
                    if (typeof msg.timestamp === "number") msgTime = msg.timestamp;
                    else if (msg.timestamp.seconds) msgTime = msg.timestamp.seconds * 1000;
                    else if (msg.timestamp.toDate) msgTime = msg.timestamp.toDate().getTime();
                }
                const formattedTime = new Date(msgTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

                const row = document.createElement("div");
                row.className = "message-row " + (msg.fromNumber === myNumber ? "sent" : "received");
                
                let ticks = "";
                if (msg.fromNumber === myNumber) {
                    if (msg.read) ticks = '<span class="material-icons message-status read" style="font-size: 14px; margin-left: 2px;">done_all</span>';
                    else if (msg.delivered) ticks = '<span class="material-icons message-status" style="font-size: 14px; margin-left: 2px; color: var(--text-light-gray)">done_all</span>';
                    else ticks = '<span class="material-icons message-status" style="font-size: 14px; margin-left: 2px; color: var(--text-light-gray)">done</span>';
                }

                const textEscaped = escapeHTML(msg.text);

                row.innerHTML = `
                    <div class="message-bubble">
                        <div class="message-text">${textEscaped}</div>
                        <div class="message-info">
                            <span>${formattedTime}</span>
                            ${ticks}
                        </div>
                    </div>
                `;
                container.appendChild(row);
            });

            // Auto Scroll a la última burbuja
            container.scrollTop = container.scrollHeight;
        });

    // Cargar de nuevo la lista para marcar la selección
    loadChatsList();
};

function sendChatMessage() {
    const text = document.getElementById("chat-message-input").value.trim();
    if (!text || !activeChatNumber) return;

    document.getElementById("chat-message-input").value = "";

    const roomId = getChatRoomId(myNumber, activeChatNumber);
    const messagesRef = db.collection("chats").doc(roomId).collection("messages");
    const docId = messagesRef.doc().id;

    const message = {
        id: docId,
        fromNumber: myNumber,
        toNumber: activeChatNumber,
        text: text,
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        delivered: false,
        read: false
    };

    messagesRef.doc(docId).set(message).then(() => {
        // Actualizar último mensaje de la sala de chat
        db.collection("chats").doc(roomId).set({
            roomId: roomId,
            participants: [myNumber, activeChatNumber],
            lastMessageText: text,
            lastMessageTimestamp: Date.now(),
            lastSender: myNumber
        }, { merge: true });
    }).catch(err => alert("Error al enviar: " + err.message));
}

// --- LLAMADAS VOIP (WEBRTC) ---

function initiateVoipCall(targetNumber) {
    if (!targetNumber) return alert("Ingresa un número");
    if (targetNumber === myNumber) return alert("No puedes llamarte a ti mismo");

    currentCallNumber = targetNumber;
    isIncomingCall = false;

    // Mostrar overlay de llamada en modo "Marcando..."
    document.getElementById("call-user-name").innerText = targetNumber;
    document.getElementById("call-user-number").innerText = targetNumber;
    document.getElementById("call-status-label").innerText = "Marcando...";
    document.getElementById("call-timer-label").style.display = "none";
    document.getElementById("call-overlay").style.display = "flex";

    // Verificar si el navegador admite WebRTC (requiere HTTPS o localhost)
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert("Error de seguridad: Tu navegador bloquea el acceso al micrófono.\n\n" +
              "Esto ocurre si la web no se sirve bajo una conexión segura (HTTPS) o localhost.\n" +
              "Por favor, utiliza HTTPS o localhost para poder realizar llamadas.");
        endCallLocally();
        return;
    }

    // Adquirir Micrófono
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        localStream = stream;
        
        // Crear conexión peer
        peerConnection = new RTCPeerConnection(peerConfig);
        
        // Listeners de estado para depuración
        peerConnection.onconnectionstatechange = () => {
            console.log("WebRTC Connection State (Caller):", peerConnection.connectionState);
            if (peerConnection.connectionState === "failed" || peerConnection.connectionState === "disconnected") {
                console.warn("La conexión WebRTC falló o se desconectó");
                endCallLocally();
            }
        };
        peerConnection.oniceconnectionstatechange = () => {
            console.log("WebRTC ICE Connection State (Caller):", peerConnection.iceConnectionState);
        };

        peerConnection.ontrack = event => {
            console.log("Track de audio remoto recibido (Caller):", event.track.kind);
            if (event.streams && event.streams[0]) {
                if (remoteAudio.srcObject !== event.streams[0]) {
                    remoteAudio.srcObject = event.streams[0];
                }
            } else {
                if (!remoteAudio.srcObject) {
                    remoteAudio.srcObject = new MediaStream();
                }
                remoteAudio.srcObject.addTrack(event.track);
            }
            // Forzar reproducción debido a políticas de autoplay
            remoteAudio.play().catch(err => console.warn("Autoplay de audio remoto bloqueado:", err));
        };
        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

        // ICE Candidates de nuestro lado -> enviar a Firestore
        peerConnection.onicecandidate = event => {
            if (event.candidate) {
                sendIceCandidateToFirebase(targetNumber, true, event.candidate);
            }
        };

        // Crear Oferta SDP
        peerConnection.createOffer().then(offer => {
            peerConnection.setLocalDescription(offer).then(() => {
                // Registrar sesión en Firestore
                db.collection("calls").doc(targetNumber).set({
                    callerNumber: myNumber,
                    calleeNumber: targetNumber,
                    status: "ringing",
                    offerSdp: offer.sdp,
                    answerSdp: null
                });

                // Empezar a escuchar ICE candidates del callee YA (pueden llegar antes del answer SDP)
                listenRemoteIceCandidates(targetNumber, false);

                // Escuchar estado de respuesta del receptor
                listenToCallSessionUpdates(targetNumber);
            });
        });
    }).catch(err => {
        alert("Error de micrófono: " + err.message);
        endCallLocally();
    });
}

function listenToCallSessionUpdates(sessionDocId) {
    // Limpiar listener anterior si existe
    if (callSessionListener) {
        callSessionListener();
        callSessionListener = null;
    }
    // Escuchar el documento de la sesión de llamada
    let remoteDescriptionSet = false;
    callSessionListener = db.collection("calls").doc(sessionDocId)
        .onSnapshot(doc => {
            if (!doc.exists) {
                endCallLocally();
                return;
            }

            const session = doc.data();
            if (session.status === "rejected") {
                document.getElementById("call-status-label").innerText = "Llamada rechazada";
                setTimeout(() => endCallLocally(), 1500);
            } else if (session.status === "ended") {
                endCallLocally();
            } else if (session.status === "answered" && session.answerSdp && !remoteDescriptionSet) {
                remoteDescriptionSet = true; // Evitar procesar el answer más de una vez
                document.getElementById("call-status-label").innerText = "Llamada Conectada";
                startCallTimer();
                
                // Conectar WebRTC con la respuesta SDP del callee
                if (peerConnection) {
                    const desc = new RTCSessionDescription({ type: 'answer', sdp: session.answerSdp });
                    peerConnection.setRemoteDescription(desc).catch(e => {
                        console.warn("setRemoteDescription answer failed:", e);
                    });
                    // NOTA: listenRemoteIceCandidates ya fue llamado en initiateVoipCall
                    // justo después de setLocalDescription para evitar race conditions
                }
            }
        });
}


function listenRemoteIceCandidates(sessionDocId, listenForCaller) {
    db.collection("calls").doc(sessionDocId).collection("candidates")
        .where("caller", "==", listenForCaller)
        .onSnapshot(snapshot => {
            if (snapshot) {
                snapshot.docChanges().forEach(change => {
                    if (change.type === "added") {
                        const data = change.doc.data();
                        const cand = new RTCIceCandidate({
                            sdpMid: data.sdpMid,
                            sdpMLineIndex: data.sdpMLineIndex,
                            candidate: data.sdp
                        });
                        peerConnection.addIceCandidate(cand).catch(e => {});
                    }
                });
            }
        });
}

function sendIceCandidateToFirebase(sessionDocId, isCaller, candidate) {
    db.collection("calls").doc(sessionDocId).collection("candidates").add({
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
        sdp: candidate.candidate,
        caller: isCaller
    });
}

// Recibir Llamada
function showIncomingCallPopup(callerNumber) {
    currentCallNumber = callerNumber;
    isIncomingCall = true;
    document.getElementById("incoming-caller-label").innerText = "Número: " + callerNumber;
    document.getElementById("incoming-call-modal").style.display = "flex";
    
    // Play ringtone
    ringtoneAudio.currentTime = 0;
    ringtoneAudio.play().catch(() => {});
}

function hideIncomingCallPopup() {
    document.getElementById("incoming-call-modal").style.display = "none";
    ringtoneAudio.pause();
}

function acceptIncomingCall() {
    hideIncomingCallPopup();

    document.getElementById("call-user-name").innerText = currentCallNumber;
    document.getElementById("call-user-number").innerText = currentCallNumber;
    document.getElementById("call-status-label").innerText = "Conectando...";
    document.getElementById("call-timer-label").style.display = "none";
    document.getElementById("call-overlay").style.display = "flex";

    // Verificar si el navegador admite WebRTC (requiere HTTPS o localhost)
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert("Error de seguridad: Tu navegador bloquea el acceso al micrófono.\n\n" +
              "Esto ocurre si la web no se sirve bajo una conexión segura (HTTPS) o localhost.\n" +
              "Por favor, utiliza HTTPS o localhost para poder contestar llamadas.");
        rejectIncomingCall();
        return;
    }

    // Actualizar estado a Conectado y responder WebRTC
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        localStream = stream;
        
        peerConnection = new RTCPeerConnection(peerConfig);
        
        // Listeners de estado para depuración
        peerConnection.onconnectionstatechange = () => {
            console.log("WebRTC Connection State (Callee):", peerConnection.connectionState);
            if (peerConnection.connectionState === "failed" || peerConnection.connectionState === "disconnected") {
                console.warn("La conexión WebRTC falló o se desconectó");
                endCallLocally();
            }
        };
        peerConnection.oniceconnectionstatechange = () => {
            console.log("WebRTC ICE Connection State (Callee):", peerConnection.iceConnectionState);
        };

        peerConnection.ontrack = event => {
            console.log("Track de audio remoto recibido (Callee):", event.track.kind);
            if (event.streams && event.streams[0]) {
                if (remoteAudio.srcObject !== event.streams[0]) {
                    remoteAudio.srcObject = event.streams[0];
                }
            } else {
                if (!remoteAudio.srcObject) {
                    remoteAudio.srcObject = new MediaStream();
                }
                remoteAudio.srcObject.addTrack(event.track);
            }
            // Forzar reproducción debido a políticas de autoplay
            remoteAudio.play().catch(err => console.warn("Autoplay de audio remoto bloqueado:", err));
        };
        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

        // ICE Candidates de nuestro lado -> enviar
        peerConnection.onicecandidate = event => {
            if (event.candidate) {
                sendIceCandidateToFirebase(myNumber, false, event.candidate);
            }
        };

        // Obtener descripción de la oferta
        db.collection("calls").doc(myNumber).get().then(doc => {
            if (doc.exists) {
                const session = doc.data();
                const desc = new RTCSessionDescription({ type: 'offer', sdp: session.offerSdp });
                
                peerConnection.setRemoteDescription(desc).then(() => {
                    // Empezar a escuchar ICE candidates del caller YA (pueden llegar antes de crear el answer)
                    listenRemoteIceCandidates(myNumber, true);

                    peerConnection.createAnswer().then(answer => {
                        peerConnection.setLocalDescription(answer).then(() => {
                            // Enviar respuesta en Firestore
                            db.collection("calls").doc(myNumber).update({
                                status: "answered",
                                answerSdp: answer.sdp
                            });

                            document.getElementById("call-status-label").innerText = "Llamada Conectada";
                            startCallTimer();

                            // ICE candidates del caller ya se escuchan desde antes del answer
                            // (se inician en acceptIncomingCall justo tras setRemoteDescription)
                            
                            // Escuchar si cuelgan
                            listenToCallSessionUpdates(myNumber);
                        });
                    });
                });
            } else {
                endCallLocally();
            }
        });

    }).catch(err => {
        alert("Error de micrófono: " + err.message);
        rejectIncomingCall();
    });
}

function rejectIncomingCall() {
    hideIncomingCallPopup();
    if (currentCallNumber) {
        db.collection("calls").doc(myNumber).update({ status: "rejected" });
    }
}

function rejectOrHangupCall() {
    const sessionDocId = isIncomingCall ? myNumber : currentCallNumber;
    if (sessionDocId) {
        db.collection("calls").doc(sessionDocId).update({ status: "ended" });
    }
    endCallLocally();
}

function endCallLocally() {
    // Parar temporizador
    clearInterval(callTimer);
    callDurationSeconds = 0;
    
    // Ocultar overlays
    document.getElementById("call-overlay").style.display = "none";
    document.getElementById("incoming-call-modal").style.display = "none";
    
    // Parar sonidos
    ringtoneAudio.pause();
    ringtoneAudio.currentTime = 0;
    
    // Limpiar audio remoto
    remoteAudio.srcObject = null;
    remoteAudio.pause();
    
    // Registrar historial localmente
    saveCallRecordLocally();

    // Limpiar WebRTC
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    if (peerConnection) {
        peerConnection.ontrack = null;
        peerConnection.onicecandidate = null;
        peerConnection.close();
        peerConnection = null;
    }

    if (callSessionListener) {
        callSessionListener();
        callSessionListener = null;
    }

    // Limpiar Firebase: el caller borra el documento; el callee solo actualiza estado
    const sessionDocId = isIncomingCall ? myNumber : currentCallNumber;
    if (sessionDocId) {
        if (!isIncomingCall) {
            // Caller: borrar candidatos y documento
            setTimeout(() => {
                db.collection("calls").doc(sessionDocId).collection("candidates").get().then(snap => {
                    snap.forEach(d => d.ref.delete());
                    db.collection("calls").doc(sessionDocId).delete();
                });
            }, 1500);
        } else {
            // Callee: solo marcar como ended (el caller borrará el doc)
            db.collection("calls").doc(sessionDocId).update({ status: "ended" }).catch(() => {});
        }
    }

    isIncomingCall = false;
    currentCallNumber = "";
}

function startCallTimer() {
    const timerLabel = document.getElementById("call-timer-label");
    timerLabel.style.display = "block";
    callDurationSeconds = 0;
    timerLabel.innerText = "00:00";
    
    clearInterval(callTimer);
    callTimer = setInterval(() => {
        callDurationSeconds++;
        const minutes = Math.floor(callDurationSeconds / 60);
        const seconds = callDurationSeconds % 60;
        timerLabel.innerText = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }, 1000);
}

function toggleCallMute() {
    if (localStream) {
        isMuted = !isMuted;
        localStream.getAudioTracks().forEach(track => track.enabled = !isMuted);
        
        const muteBtn = document.getElementById("btn-call-mute");
        if (isMuted) {
            muteBtn.classList.add("active");
            muteBtn.innerHTML = '<span class="material-icons">mic_off</span>';
        } else {
            muteBtn.classList.remove("active");
            muteBtn.innerHTML = '<span class="material-icons">mic</span>';
        }
    }
}

function toggleCallSpeaker() {
    // En navegadores, el audio ya se reproduce por el altavoz por defecto.
    // Solo actualizamos el estado visual del botón.
    const speakerBtn = document.getElementById("btn-call-speaker");
    speakerBtn.classList.toggle("active");
}

function saveCallRecordLocally() {
    if (!currentCallNumber) return;
    
    const record = {
        phoneNumber: currentCallNumber,
        type: isIncomingCall ? (callDurationSeconds > 0 ? "incoming" : "missed") : "outgoing",
        timestamp: Date.now(),
        duration: callDurationSeconds
    };
    
    db.collection("users").doc(currentUser.uid).collection("call_history").add(record);
}

function loadCallHistoryList() {
    const listContainer = document.getElementById("history-list");
    listContainer.innerHTML = '<div class="text-center p-4">Cargando historial...</div>';

    db.collection("users").doc(currentUser.uid).collection("call_history")
        .get()
        .then(snapshot => {
            listContainer.innerHTML = "";
            if (snapshot.empty) {
                listContainer.innerHTML = '<div class="empty-state"><h4>Historial de llamadas vacío</h4></div>';
                return;
            }

            // Ordenar por fecha descendente
            const records = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
                .sort((a, b) => b.timestamp - a.timestamp);

            records.forEach(rec => {
                const dateStr = new Date(rec.timestamp).toLocaleString();
                const typeIcon = rec.type === "incoming" ? "call_received" : (rec.type === "missed" ? "call_missed" : "call_made");
                const typeColor = rec.type === "missed" ? "var(--hangup-red)" : "var(--call-green)";
                const durationStr = rec.duration > 0 ? `${Math.floor(rec.duration / 60)}m ${rec.duration % 60}s` : "Perdida";

                const phoneEscaped = escapeHTML(rec.phoneNumber);

                const item = document.createElement("div");
                item.className = "list-item";
                item.innerHTML = `
                    <div class="list-item-avatar">
                        <span class="material-icons" style="color: ${typeColor};">${typeIcon}</span>
                    </div>
                    <div class="list-item-info">
                        <div class="list-item-title">${phoneEscaped}</div>
                        <div class="list-item-subtitle">${dateStr} • Duración: ${durationStr}</div>
                    </div>
                `;
                listContainer.appendChild(item);
            });
        });
}

function clearCallHistory() {
    if (confirm("¿Estás seguro de que quieres limpiar tu historial de llamadas?")) {
        db.collection("users").doc(currentUser.uid).collection("call_history").get().then(snap => {
            const batch = db.batch();
            snap.forEach(doc => batch.delete(doc.ref));
            batch.commit().then(() => {
                alert("Historial limpiado");
                loadCallHistoryList();
            });
        });
    }
}

// --- DIALER TECLADO ---

function setupDialer() {
    const dialInput = document.getElementById("dial-input");
    const dialBtns = document.querySelectorAll(".dial-btn");
    
    dialBtns.forEach(btn => {
        btn.addEventListener("click", () => {
            dialInput.value += btn.getAttribute("data-val");
        });
    });

    document.getElementById("btn-dial-delete").addEventListener("click", () => {
        dialInput.value = dialInput.value.slice(0, -1);
    });

    document.getElementById("btn-initiate-voip").addEventListener("click", () => {
        initiateVoipCall(dialInput.value.trim());
    });
}

// --- NOTIFICACIONES Y SONIDOS ---

function checkNotificationPermission() {
    if (!("Notification" in window)) return;
    
    if (Notification.permission === "default") {
        document.getElementById("notif-banner").style.display = "flex";
    }
}

function requestNotificationPermission() {
    if (!("Notification" in window)) return;
    
    Notification.requestPermission().then(permission => {
        document.getElementById("notif-banner").style.display = "none";
        if (permission === "granted") {
            alert("¡Notificaciones de escritorio habilitadas!");
        }
    });
}

function showDesktopNotification(title, text, contactNumber) {
    if (Notification.permission === "granted" && document.hidden) {
        const notif = new Notification(title, {
            body: text,
            icon: "https://fonts.gstatic.com/s/i/materialicons/forum/v6/24px.svg"
        });
        notif.onclick = () => {
            window.focus();
            openDirectChat(contactNumber, contactNumber);
        };
    }
}

function playNotificationSound() {
    notificationAudio.currentTime = 0;
    notificationAudio.play().catch(() => {});
}

// --- UTILERÍAS ---

function getChatRoomId(number1, number2) {
    return number1 < number2 ? `${number1}_${number2}` : `${number2}_${number1}`;
}

function formatTimestamp(timestamp) {
    if (!timestamp) return "";
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function showView(containerId) {
    const containers = ["app-loader", "login-container", "number-container", "verification-container", "dashboard-container"];
    containers.forEach(id => {
        document.getElementById(id).style.display = (id === containerId) ? "flex" : "none";
    });
}

function showLoader(show, message = "Cargando...") {
    const loader = document.getElementById("app-loader");
    loader.querySelector("h2").innerText = message;
    loader.style.display = show ? "flex" : "none";
}
