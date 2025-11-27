import makeWASocket, { 
    DisconnectReason, 
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers
} from '@whiskeysockets/baileys';
import pino from 'pino';
import readline from 'readline';

// Interface pour lire l'input utilisateur
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (text) => new Promise((resolve) => rl.question(text, resolve));

async function connectWhatsApp() {
    // Utiliser l'authentification multi-fichiers
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
    
    // Obtenir la dernière version de Baileys (optionnel, peut être retiré pour plus de stabilité)
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`📦 Version WhatsApp Web: ${version.join('.')}`);
    console.log(`✅ Dernière version: ${isLatest ? 'Oui' : 'Non'}`);
    
    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        // IMPORTANT pour pairing code: utiliser un navigateur valide
        browser: Browsers.macOS('Chrome'),
        markOnlineOnConnect: true,
        syncFullHistory: false,
        // Nouveau dans v7: Mobile
        mobile: false,
        getMessage: async (key) => {
            return { conversation: '' };
        }
    });

    let pairingCodeRequested = false;

    // Sauvegarder les credentials
    sock.ev.on('creds.update', saveCreds);

    // Gérer la connexion
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // Demander le pairing code uniquement lors de la connexion initiale
        if ((connection === 'connecting' || qr !== undefined) && 
            !sock.authState.creds.registered && 
            !pairingCodeRequested) {
            
            pairingCodeRequested = true;
            
            console.log('\n╔═══════════════════════════════════════╗');
            console.log('║     📱 CONNEXION PAIRING CODE         ║');
            console.log('╚═══════════════════════════════════════╝\n');
            console.log('⚠️  Format du numéro: [code pays][numéro]');
            console.log('Exemples valides:');
            console.log('  🇲🇦 Maroc:     212612345678');
            console.log('  🇫🇷 France:    33612345678');
            console.log('  🇧🇪 Belgique:  32471234567');
            console.log('  🇺🇸 USA:       12025551234\n');
            
            try {
                const phoneNumber = await question('➡️  Entrez votre numéro WhatsApp: ');
                
                // Nettoyer le numéro
                const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
                
                if (cleanNumber.length < 10 || cleanNumber.length > 15) {
                    console.log('\n❌ ERREUR: Numéro invalide (10-15 chiffres requis)');
                    process.exit(1);
                }
                
                console.log(`\n✅ Numéro validé: ${cleanNumber}`);
                console.log('⏳ Génération du code de jumelage...\n');
                
                // Demander le pairing code
                const code = await sock.requestPairingCode(cleanNumber);
                
                console.log('╔═══════════════════════════════════════╗');
                console.log('║                                       ║');
                console.log(`║     CODE:  ${code.toUpperCase()}               ║`);
                console.log('║                                       ║');
                console.log('╚═══════════════════════════════════════╝\n');
                console.log('📱 ÉTAPES SUR WHATSAPP:');
                console.log('1. Ouvrir WhatsApp');
                console.log('2. Menu (⋮) → Appareils connectés');
                console.log('3. Connecter un appareil');
                console.log('4. "Connecter avec numéro de téléphone"');
                console.log(`5. Entrer: ${code.toUpperCase()}\n`);
                console.log('⏰ ATTENTION: Code valide 60 secondes!\n');
                
            } catch (error) {
                console.log('\n❌ ERREUR:', error.message);
                console.log('\n🔍 Vérifiez:');
                console.log('  - Format du numéro correct');
                console.log('  - Connexion internet active');
                console.log('  - WhatsApp installé sur ce numéro');
                process.exit(1);
            }
        }
        
        if (connection === 'connecting') {
            console.log('🔄 Connexion en cours...');
        }
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log('\n❌ Connexion fermée');
            console.log(`Code: ${statusCode}`);
            
            if (statusCode === DisconnectReason.badSession) {
                console.log('\n⚠️  SESSION INVALIDE');
                console.log('💡 Solution:');
                console.log('   rm -rf auth_info_baileys');
                console.log('   node bot.js\n');
                return;
            }
            
            if (statusCode === DisconnectReason.connectionClosed) {
                console.log('\n⚠️  CONNEXION FERMÉE PAR WHATSAPP');
                console.log('🔍 Causes possibles:');
                console.log('  - Code expiré (>60 sec)');
                console.log('  - Mauvais numéro');
                console.log('  - Trop d\'appareils connectés');
                console.log('\n💡 Solution:');
                console.log('   rm -rf auth_info_baileys');
                console.log('   node bot.js\n');
            }
            
            if (shouldReconnect) {
                console.log('🔄 Reconnexion dans 5 secondes...\n');
                setTimeout(() => connectWhatsApp(), 5000);
            }
        } else if (connection === 'open') {
            console.log('\n╔═══════════════════════════════════════╗');
            console.log('║   ✅ BOT CONNECTÉ AVEC SUCCÈS! ✅     ║');
            console.log('╚═══════════════════════════════════════╝\n');
            console.log('📩 En attente de messages...');
            console.log('💡 Commandes: !ping, !bonjour, !help, !info\n');
        }
    });

    // Recevoir les messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        
        const msg = messages[0];
        if (!msg.message) return;
        
        // Extraire le texte
        const messageText = msg.message.conversation || 
                           msg.message.extendedTextMessage?.text || '';
        
        // V7: utiliser msg.key.remoteJid (pas de changement nécessaire)
        const from = msg.key.remoteJid;
        const isGroup = from?.endsWith('@g.us');
        
        console.log(`\n📩 Message ${isGroup ? 'groupe' : 'privé'}`);
        console.log(`   De: ${from}`);
        console.log(`   Message: "${messageText}"`);
        
        // Répondre aux commandes
        if (messageText.toLowerCase() === '!ping') {
            await sock.sendMessage(from, { 
                text: '🏓 Pong! Bot en ligne!' 
            });
            console.log('✅ Répondu: Pong');
        }
        
        if (messageText.toLowerCase() === '!bonjour') {
            await sock.sendMessage(from, { 
                text: '👋 Salut! Bot WhatsApp avec Baileys v7!' 
            });
            console.log('✅ Répondu: Bonjour');
        }
        
        if (messageText.toLowerCase() === '!help') {
            const helpText = `🤖 *Commandes disponibles*

📌 !ping - Tester le bot
📌 !bonjour - Salutation
📌 !info - Info du bot
📌 !help - Cette aide

Powered by Baileys v7 🚀`;
            
            await sock.sendMessage(from, { text: helpText });
            console.log('✅ Répondu: Help');
        }
        
        if (messageText.toLowerCase() === '!info') {
            const infoText = `ℹ️ *Informations Bot*

✅ Status: En ligne
📦 Baileys: v7.x (ESM)
🔗 Connexion: Stable
⚡ Prêt à répondre!`;
            
            await sock.sendMessage(from, { text: infoText });
            console.log('✅ Répondu: Info');
        }
    });

    return sock;
}

// Démarrer le bot
console.log('\n╔═══════════════════════════════════════╗');
console.log('║  🚀 BOT WHATSAPP - BAILEYS V7.x 🚀   ║');
console.log('╚═══════════════════════════════════════╝\n');
console.log('⏳ Initialisation...\n');

connectWhatsApp().catch(err => {
    console.error('\n❌ ERREUR FATALE:', err.message);
    console.error('\n💡 Solutions:');
    console.error('1. Vérifier connexion internet');
    console.error('2. rm -rf auth_info_baileys');
    console.error('3. npm install @whiskeysockets/baileys@latest');
    console.error('4. node bot.js\n');
    process.exit(1);
});
