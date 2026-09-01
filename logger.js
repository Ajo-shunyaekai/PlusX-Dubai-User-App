import winston from "winston";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import moment from "moment-timezone";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const errorLogFilePath = path.join(__dirname, "error.log");

if (!fs.existsSync(errorLogFilePath)) {
  fs.writeFileSync(errorLogFilePath, "", { flag: "a+" });
}

const logger = winston.createLogger({
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
            let timeZone = moment().tz("Asia/Dubai");
            let currentTime  = timeZone.format('YYYY-MM-DD HH:mm:ss');

            return `${currentTime} [${level.toUpperCase()}]: ${message}`;
        })
    ),
    transports: [
        new winston.transports.File({
            filename: errorLogFilePath,
            level: "error",
            handleExceptions: true,
            maxsize: 5242880,
            maxFiles: 5,
        })
    ],
});

export default logger;
