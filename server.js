import express from 'express';
import bodyParser from 'body-parser';
import apiRoutes from './routes/api.js';

import path from 'path';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { errorHandler } from './middleware/errorHandler.js';
import dotenv from 'dotenv';
dotenv.config();

const app  = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 8802;

import { Server } from 'socket.io'; 
import http from 'http';

import cron from 'node-cron';
import mqtt from 'mqtt';

import { stripeWebhook, failedPODBooking, failedValetBooking, failedRSABooking, scanChargePlugCheckCron } from './controller/TestController.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const corsOptions = {
    origin : [
        'https://backend.plusxelectric.com'
    ],
    // origin : "*",
    methods: 'GET, POST, PUT, DELETE',
    credentials: true
};
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), stripeWebhook);

app.use(cors(corsOptions));
// app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(bodyParser.json());
app.use(cookieParser());

// Set EJS as the templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use('/api', apiRoutes);

app.get('/.well-known/apple-app-site-association', (req, resp) => {
    return resp.json({
        
        "applinks"    : {
            "apps"    : [],
            "details" : [
                {
                    "appID" : "5X456GQ4TF.com.shunyaekaitechnologies.PLUSXELECTRIC",
                    "paths" : ["/redirect/*", "/pod/*", "/payment-success", "/payment-success/*", "/payment-cancel", "/payment-cancel/*" ]
                }
            ]
        }
    });
});
app.get('/pod/id6503144034', (req,res, resp) => {
   res.redirect('https://www.plusxelectric.com');
});
app.get('/payment-success', (req, res) => {
    
    res.redirect(`plusxelectric://payment-success`);
});
app.get('/payment-cancel', (req, res) => {
   
    res.redirect(`plusxelectric://payment-cancel`);
});

cron.schedule('*/5 * * * *', async () => {
    await failedPODBooking()
    await failedValetBooking() 
    await failedRSABooking()
    console.log('This runs every 5 minutes', new Date().toISOString());
});

// Scan charge: fail sessions with no kWh after 3 min (backup for chargingStart setTimeout)
// cron.schedule('* * * * *', async () => {
//     await scanChargePlugCheckCron();
//     console.log('This runs every minute', new Date().toISOString());
// });
app.use(errorHandler);

// Socket Code Here 
const server = http.createServer(app);

export const io = new Server(server, {
    cors : corsOptions,
});

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});


// MQTT Code
const client = mqtt.connect(process.env.MQTT_URL, {
    clientId  : process.env.MQTT_CILENT_ID,
    username  : process.env.MQTT_USERNAME,
    password  : process.env.MQTT_PASSWORD,
    keepalive : 3600,  // auto reconnect every 5 sec
    will: {
        topic   : 'device/status',
        payload : 'offline',
        retain  : true
    }
});

client.on('connect', () => {
    console.log('mqtt Connected');
    client.publish('device/status', 'online', { retain: true });
    client.subscribe('device/cmd');
});

client.on('message', (topic, msg) => {
  console.log(topic, msg.toString());
});

client.on('reconnect', () => console.log('Reconnecting...'));
client.on('close', () => console.log('Disconnected'));
client.on('error', err => console.log('Error', err.message));

export default client;
