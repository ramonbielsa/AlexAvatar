document.addEventListener('DOMContentLoaded', () => {
    // --- Referencias a elementos del DOM ---
    const avatarContainer = document.getElementById('avatar-container');
    const chatContainer = document.getElementById('chat-container');
    const chatLog = document.getElementById('chat-log');
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');
    const micBtn = document.getElementById('mic-btn');
    const videoElement = document.getElementById('avatar-video');
    const statusDiv = document.getElementById('status');
    const SERVER_URL = 'http://localhost:3000';
    
    // --- 2. VARIABLES DE ESTADO ---
    let rtcPeerConnection;
    let streamId;
    let sessionId;
    let conversationHistory = [];
    
    // --- 3. DEFINICIÓN DE FUNCIONES PRINCIPALES ---
    const updateStatus = (message) => {
        statusDiv.textContent = message;
    };
    
    const connectToDID = async () => {
        if (rtcPeerConnection && rtcPeerConnection.connectionState === 'connected') return;
        updateStatus('Conectando...');
        try {
            const sessionResponse = await fetch(`${SERVER_URL}/api/d-id/create-stream`, { method: 'POST' });
            const sessionData = await sessionResponse.json();
            if (!sessionResponse.ok) throw new Error(sessionData.message || sessionData.description || 'Error al crear el stream.');
            
            streamId = sessionData.id;
            sessionId = sessionData.session_id;
            
            rtcPeerConnection = new RTCPeerConnection({ iceServers: sessionData.ice_servers });
            rtcPeerConnection.ontrack = (event) => {
                if (videoElement.srcObject !== event.streams[0]) {
                    videoElement.srcObject = event.streams[0];
                    updateStatus('Conectado');
                    videoElement.muted = false;
                }
            };
            
            await rtcPeerConnection.setRemoteDescription(sessionData.offer);
            const answer = await rtcPeerConnection.createAnswer();
            await rtcPeerConnection.setLocalDescription(answer);
            
            await fetch(`${SERVER_URL}/api/d-id/start-stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ stream_id: streamId, session_id: sessionId, answer }),
            });
        } catch (error) {
            console.error('Fallo en la conexión con D-ID:', error);
            updateStatus(`Error: ${error.message}`);
        }
    };
    
    const talkToDID = async (text, type = 'text') => {
        // Primero, comprobamos si la conexión existe.
        if (!rtcPeerConnection) {
            updateStatus('Error: La conexión no se ha iniciado.');
            return;
        }
    
        // Luego, comprobamos si la conexión está en un estado fallido o cerrado.
        // Permitimos que la función continúe si está en 'new', 'connecting' o 'connected'.
        const badStates = ['failed', 'closed', 'disconnected'];
        if (badStates.includes(rtcPeerConnection.connectionState)) {
            updateStatus('Error: Conexión perdida.');
            console.error('No se puede hablar, estado de conexión:', rtcPeerConnection.connectionState);
            return;
        }
    
        // Si la conexión está bien, procedemos con la llamada a la API.
        await fetch(`${SERVER_URL}/api/d-id/talk-stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stream_id: streamId, session_id: sessionId, text, type }),
        });
    };
    
    const appendMessage = (text, classNames) => {
        const messageDiv = document.createElement('div');
        messageDiv.classList.add('message');
        classNames.split(' ').forEach(cls => {
            if (cls) messageDiv.classList.add(cls);
        });
        messageDiv.innerText = text;
        chatLog.appendChild(messageDiv);
        chatLog.scrollTop = chatLog.scrollHeight;
        return messageDiv;
    };
    
    const sendMessage = async () => {
        const userMessageText = chatInput.value.trim();
        if (userMessageText === '') return;
    
        appendMessage(userMessageText, 'user-message');
        chatInput.value = '';
        conversationHistory.push({ role: 'user', parts: [{ text: userMessageText }] });
        const botMessageElement = appendMessage('', 'bot-message thinking');
    
        try {
            const response = await fetch(`${SERVER_URL}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: userMessageText, history: conversationHistory.slice(0, -1) }),
            });
    
            if (!response.ok || !response.body) {
                throw new Error('La respuesta del servidor no es válida.');
            }
            
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let completeResponse = '';
            botMessageElement.classList.remove('thinking');
    
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
    
                const chunkText = decoder.decode(value);
                completeResponse += chunkText;
                botMessageElement.innerText = completeResponse;
                chatLog.scrollTop = chatLog.scrollHeight;
            }
    
            if (completeResponse) {
                conversationHistory.push({ role: 'model', parts: [{ text: completeResponse }] });
                await talkToDID(completeResponse);
            }
    
        } catch (error) {
            botMessageElement.classList.remove('thinking');
            console.error('Error al obtener respuesta de Gemini (stream):', error);
            botMessageElement.innerText = 'Lo siento, hubo un error al procesar la respuesta.';
        }
    };
    
    // --- 4. EVENT LISTENERS E INICIALIZACIÓN ---
    
    // El clic en el avatar oculta/muestra el chat
    avatarContainer.addEventListener('click', () => {
        chatContainer.classList.toggle('visible');
        if (chatContainer.classList.contains('visible')) {
            chatInput.focus();
        }
    });
    
    sendBtn.addEventListener('click', sendMessage);
    chatInput.addEventListener('keypress', (e) => e.key === 'Enter' && sendMessage());
    
    // Lógica del micrófono (Speech Recognition)
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.lang = 'es-ES';
        recognition.interimResults = false;
        micBtn.addEventListener('click', () => {
            micBtn.classList.add('is-listening');
            recognition.start();
        });
        recognition.onresult = (event) => chatInput.value = event.results[0][0].transcript;
        recognition.onend = () => {
            micBtn.classList.remove('is-listening');
            sendMessage();
        };
        recognition.onerror = (e) => {
            console.error('Error de voz:', e.error);
            micBtn.classList.remove('is-listening');
        };
    } else {
        micBtn.style.display = 'none';
    }
    
    // Cerrar la conexión al salir de la página
    window.addEventListener('beforeunload', () => {
        if (streamId && sessionId) {
            const data = JSON.stringify({ stream_id: streamId, session_id: sessionId });
            navigator.sendBeacon(`${SERVER_URL}/api/d-id/close-stream`, new Blob([data], { type: 'application/json' }));
        }
    });
    // Inicia la aplicación al cargar la página
    const initializeApp = () => {
        avatarContainer.classList.add('expanded'); // Expande el avatar
        connectToDID();                         // Inicia la conexión
    };

    initializeApp();
});