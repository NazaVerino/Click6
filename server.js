const WebSocket = require('ws');
const http = require('http');
// const path = require('path'); // No usado en esta versión simplificada
// const fs = require('fs'); // No usado en esta versión simplificada

// Configuración del servidor
const PORT = 3000;
const server = http.createServer();
const wss = new WebSocket.Server({ server });

// Almacenamiento en memoria
const rooms = new Map(); // roomCode -> {participants: Set<string>, hostUsername: string, createdAt: Date, gameState: string, gameScores: Object, gameStartTime: number, gameDuration: number, gameTimerId: NodeJS.Timeout | null}
const clients = new Map(); // ws -> {username: string, roomCode: string | null}

const GAME_DURATION_SECONDS = 10; // Debe ser igual que en el cliente

// Función para generar código de sala aleatorio
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// Función para limpiar salas vacías
function cleanupEmptyRooms() {
    for (const [roomCode, room] of rooms.entries()) {
        if (room.participants.size === 0) {
            if (room.gameTimerId) clearTimeout(room.gameTimerId); // Limpiar temporizador del juego si existe
            rooms.delete(roomCode);
            console.log(`Sala ${roomCode} eliminada por estar vacía`);
        }
    }
}

// Limpiar salas vacías cada 5 minutos
setInterval(cleanupEmptyRooms, 5 * 60 * 1000);

// Función para enviar mensaje a todos los participantes de una sala
function broadcastToRoom(roomCode, message, excludeClient = null) {
    const room = rooms.get(roomCode);
    if (!room) return;

    for (const [clientWS, clientData] of clients.entries()) {
        if (clientData.roomCode === roomCode && clientWS !== excludeClient && clientWS.readyState === WebSocket.OPEN) {
            try {
                clientWS.send(JSON.stringify(message));
            } catch (e) {
                console.error(`Error enviando mensaje a cliente en sala ${roomCode}:`, e);
                // Podrías manejar la desconexión del cliente aquí si el envío falla repetidamente
            }
        }
    }
}

// Función para obtener lista de participantes de una sala
function getRoomParticipantsUsernames(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return [];
    return Array.from(room.participants);
}

// Función para enviar actualización de participantes
function sendParticipantsUpdate(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    const participantsUsernames = getRoomParticipantsUsernames(roomCode);
    broadcastToRoom(roomCode, {
        type: 'participantsUpdate',
        participants: participantsUsernames,
        hostUsername: room.hostUsername // Enviar quién es el anfitrión
    });
}

// Función para manejar la desconexión de un cliente
function handleClientDisconnect(ws) {
    const clientData = clients.get(ws);
    if (!clientData) return;

    console.log(`Cliente ${clientData.username || 'desconocido'} desconectado`);

    // Remover de la sala si estaba en una
    if (clientData.roomCode) {
        const roomCode = clientData.roomCode;
        const room = rooms.get(roomCode);
        if (room) {
            room.participants.delete(clientData.username);
            
            // Si el anfitrión se desconecta, se elige uno nuevo o se maneja la situación
            if (clientData.username === room.hostUsername) {
                if (room.participants.size > 0) {
                    room.hostUsername = Array.from(room.participants)[0]; // El siguiente en la lista es el nuevo anfitrión
                    console.log(`Anfitrión ${clientData.username} desconectado. Nuevo anfitrión en sala ${roomCode}: ${room.hostUsername}`);
                } else {
                    // La sala quedará vacía y será eliminada por cleanupEmptyRooms
                    console.log(`Anfitrión ${clientData.username} desconectado. Sala ${roomCode} ahora vacía.`);
                     if (room.gameTimerId) clearTimeout(room.gameTimerId); // Detener juego si estaba activo
                }
            }
            
            sendParticipantsUpdate(roomCode); // Actualizar lista para todos
            
            // Si el juego estaba corriendo y la sala queda vacía o el último jugador se va
            if (room.gameState === 'running' && room.participants.size === 0) {
                 if (room.gameTimerId) clearTimeout(room.gameTimerId);
                 room.gameState = 'waiting'; // O 'aborted'
                 console.log(`Juego en sala ${roomCode} detenido porque todos los jugadores se fueron.`);
            }

            // La limpieza de salas completamente vacías la hace `cleanupEmptyRooms`
        }
    }

    // Remover cliente de la lista
    clients.delete(ws);
}

// Manejar conexiones WebSocket
wss.on('connection', (ws) => {
    console.log('Nueva conexión establecida');
    
    // Inicializar datos del cliente
    clients.set(ws, {
        username: null, // Se establecerá con el mensaje 'setUsername'
        roomCode: null
    });

    ws.on('message', (data) => {
        let message;
        try {
            message = JSON.parse(data.toString());
        } catch (error) {
            console.error('Error parseando mensaje JSON:', data.toString(), error);
            ws.send(JSON.stringify({ type: 'error', message: 'Mensaje inválido (no es JSON)' }));
            return;
        }
        
        const clientData = clients.get(ws);
        if (!clientData) { // Esto no debería ocurrir si el cliente se registró bien
            console.error('Error: No se encontraron datos para el cliente WebSocket.');
            return;
        }


        switch (message.type) {
            case 'setUsername':
                const username = message.username ? message.username.trim() : '';
                
                if (!username || username.length < 2 || username.length > 20) {
                    ws.send(JSON.stringify({ type: 'usernameSet', success: false, error: 'El nombre debe tener entre 2 y 20 caracteres' }));
                    return;
                }

                // Verificar si el nombre ya está en uso GLOBALMENTE (esto es simple, podría ser por sala)
                let usernameInUse = false;
                for (const existingClientData of clients.values()) {
                    if (existingClientData.username === username && clients.get(ws) !== existingClientData) {
                        usernameInUse = true;
                        break;
                    }
                }

                if (usernameInUse) {
                    ws.send(JSON.stringify({ type: 'usernameSet', success: false, error: 'Este nombre ya está en uso globalmente' }));
                    return;
                }

                clientData.username = username;
                ws.send(JSON.stringify({ type: 'usernameSet', success: true }));
                console.log(`Usuario ${username} estableció su nombre.`);
                break;

            case 'createRoom':
                if (!clientData.username) {
                    ws.send(JSON.stringify({ type: 'roomCreated', success: false, error: 'Primero establece tu nombre' }));
                    return;
                }
                if (clientData.roomCode) { // Si ya está en una sala
                     ws.send(JSON.stringify({ type: 'roomCreated', success: false, error: 'Ya estás en una sala. Sal primero.' }));
                    return;
                }

                let roomCode;
                do {
                    roomCode = generateRoomCode();
                } while (rooms.has(roomCode));

                const newRoom = {
                    participants: new Set([clientData.username]),
                    hostUsername: clientData.username, // El creador es el anfitrión
                    createdAt: new Date(),
                    gameState: 'waiting', // 'waiting', 'running', 'finished'
                    gameScores: {}, 
                    gameStartTime: null,
                    gameDuration: GAME_DURATION_SECONDS, 
                    gameTimerId: null
                };
                rooms.set(roomCode, newRoom);
                clientData.roomCode = roomCode;

                ws.send(JSON.stringify({ type: 'roomCreated', success: true, roomCode: roomCode }));
                sendParticipantsUpdate(roomCode);
                console.log(`Sala ${roomCode} creada por ${clientData.username}`);
                break;

            case 'joinRoom':
                if (!clientData.username) {
                    ws.send(JSON.stringify({ type: 'roomJoined', success: false, error: 'Primero establece tu nombre' }));
                    return;
                }
                 if (clientData.roomCode) {
                     ws.send(JSON.stringify({ type: 'roomJoined', success: false, error: 'Ya estás en una sala. Sal primero.' }));
                    return;
                }

                const joinRoomCode = message.roomCode ? message.roomCode.toUpperCase() : '';
                const roomToJoin = rooms.get(joinRoomCode);

                if (!roomToJoin) {
                    ws.send(JSON.stringify({ type: 'roomJoined', success: false, error: 'La sala no existe' }));
                    return;
                }
                 if (roomToJoin.participants.has(clientData.username)) {
                     ws.send(JSON.stringify({ type: 'roomJoined', success: false, error: 'Ya estás en esta sala con ese nombre.' }));
                    return;
                }
                if (roomToJoin.gameState !== 'waiting') {
                    ws.send(JSON.stringify({ type: 'roomJoined', success: false, error: 'No puedes unirte, el juego ya comenzó o terminó en esta sala.' }));
                    return;
                }


                roomToJoin.participants.add(clientData.username);
                clientData.roomCode = joinRoomCode;

                ws.send(JSON.stringify({ type: 'roomJoined', success: true, roomCode: joinRoomCode }));
                sendParticipantsUpdate(joinRoomCode);
                console.log(`${clientData.username} se unió a la sala ${joinRoomCode}`);
                break;

            case 'leaveRoom':
                if (clientData.roomCode) {
                    const roomCodeToLeave = clientData.roomCode;
                    const room = rooms.get(roomCodeToLeave);
                    if (room) {
                        room.participants.delete(clientData.username);
                        console.log(`${clientData.username} salió de la sala ${roomCodeToLeave}`);

                        if (clientData.username === room.hostUsername) {
                            if (room.participants.size > 0) {
                                room.hostUsername = Array.from(room.participants)[0];
                                console.log(`Nuevo anfitrión en sala ${roomCodeToLeave}: ${room.hostUsername}`);
                            } else {
                                // La sala se limpiará por cleanupEmptyRooms
                                if (room.gameTimerId) clearTimeout(room.gameTimerId);
                            }
                        }
                        sendParticipantsUpdate(roomCodeToLeave); // Actualizar para los restantes
                         // Si el juego estaba corriendo y la sala queda vacía
                        if (room.gameState === 'running' && room.participants.size === 0) {
                             if (room.gameTimerId) clearTimeout(room.gameTimerId);
                             room.gameState = 'waiting';
                             console.log(`Juego en sala ${roomCodeToLeave} detenido porque todos los jugadores se fueron.`);
                        }
                    }
                    clientData.roomCode = null;
                }
                ws.send(JSON.stringify({ type: 'roomLeft', success: true }));
                break;

            // --- Click Race Game Messages ---
            case 'initiateClickRace':
                if (clientData.roomCode && clientData.username) {
                    const room = rooms.get(clientData.roomCode);
                    if (room && room.hostUsername === clientData.username && room.gameState === 'waiting') {
                        if (room.participants.size === 0) { // No iniciar si no hay nadie
                             ws.send(JSON.stringify({ type: 'error', message: 'No hay suficientes jugadores para iniciar.' }));
                            return;
                        }
                        room.gameState = 'running';
                        room.gameStartTime = Date.now();
                        room.gameScores = {};
                        room.participants.forEach(participantUsername => {
                            room.gameScores[participantUsername] = 0;
                        });

                        console.log(`Carrera de Clics iniciada en sala ${clientData.roomCode} por ${clientData.username}`);
                        broadcastToRoom(clientData.roomCode, {
                            type: 'clickRaceStarted',
                            duration: room.gameDuration,
                        });

                        if (room.gameTimerId) clearTimeout(room.gameTimerId);
                        room.gameTimerId = setTimeout(() => {
                            if (room.gameState === 'running') { // Doble check
                                room.gameState = 'finished';
                                console.log(`Carrera de Clics finalizada en sala ${clientData.roomCode}`);
                                broadcastToRoom(clientData.roomCode, {
                                    type: 'clickRaceOver',
                                    scores: room.gameScores
                                });
                                // Resetear para nueva partida después de un tiempo
                                setTimeout(() => {
                                    if (rooms.has(clientData.roomCode)) {
                                        const roomToReset = rooms.get(clientData.roomCode);
                                        if(roomToReset.gameState === 'finished'){
                                            roomToReset.gameState = 'waiting';
                                            roomToReset.gameScores = {}; // Limpiar scores para la próxima
                                            console.log(`Sala ${clientData.roomCode} lista para nuevo juego.`);
                                            sendParticipantsUpdate(clientData.roomCode); // Para que el botón de iniciar se reactive
                                        }
                                    }
                                }, 5000); // 5 segundos para ver resultados
                            }
                        }, room.gameDuration * 1000);
                    } else if (room && room.hostUsername !== clientData.username) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Solo el anfitrión puede iniciar el juego.' }));
                    } else if (room && room.gameState !== 'waiting') {
                         ws.send(JSON.stringify({ type: 'error', message: 'El juego no se puede iniciar en este momento (ya está en curso o finalizado).' }));
                    }
                }
                break;

            case 'iMadeAClick':
                if (clientData.roomCode && clientData.username) {
                    const room = rooms.get(clientData.roomCode);
                    if (room && room.gameState === 'running' && room.gameScores.hasOwnProperty(clientData.username)) {
                        room.gameScores[clientData.username]++;
                        // No es necesario transmitir cada clic, solo el resultado final.
                    }
                }
                break;

            default:
                console.log('Tipo de mensaje no reconocido:', message.type);
                ws.send(JSON.stringify({ type: 'error', message: 'Tipo de mensaje no reconocido' }));
                break;
        }
    });

    ws.on('close', () => {
        handleClientDisconnect(ws);
    });

    ws.on('error', (error) => {
        console.error('Error en WebSocket:', error.message); // Solo el mensaje de error es suficiente aquí
        handleClientDisconnect(ws); // Asegurarse de limpiar
    });
});

// Manejar cierre del servidor
process.on('SIGINT', () => {
    console.log('\nCerrando servidor...');
    wss.clients.forEach(client => {
        client.close();
    });
    server.close(() => {
        console.log('Servidor cerrado');
        process.exit(0);
    });
});

// Iniciar servidor
server.listen(PORT, '0.0.0.0', () => { // Escuchar en 0.0.0.0 para acceso en red local
    console.log(`Servidor ejecutándose en puerto ${PORT}`);
    console.log(`WebSocket disponible en la IP de esta máquina, puerto ${PORT}`);
    console.log('--- Para jugar en red local, otros jugadores deben usar tu IP local ---');
    console.log('--- Ejemplo: ws://TU_IP_LOCAL:3000 ---');
});

// Mostrar estadísticas periódicamente
setInterval(() => {
    console.log(`\n--- Estadísticas (${new Date().toLocaleTimeString()}) ---`);
    console.log(`Salas activas: ${rooms.size}`);
    console.log(`Clientes conectados: ${clients.size}`);
    if (rooms.size > 0) {
        console.log('Detalle de Salas:');
        rooms.forEach((room, code) => {
            console.log(`  - Sala ${code}: ${room.participants.size} participantes (${Array.from(room.participants).join(', ')}). Anfitrión: ${room.hostUsername}. Estado: ${room.gameState}.`);
        });
    }
    console.log('--------------------------------\n');
}, 60000); // Cada 60 segundos