<<<<<<< HEAD
import nodemailer from 'nodemailer';
import dotenv from "dotenv";
dotenv.config();

// const transporter = nodemailer.createTransport({
//     host: process.env.MAIL_HOST,
//     port: process.env.MAIL_PORT,
//     auth: {
//       user: process.env.MAIL_USERNAME,
//       pass: process.env.MAIL_PASSWORD
//     }
// });

const transporter = nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: 587,
    secure: false,

    auth: {
        user: process.env.MAIL_USERNAME,
        pass: process.env.MAIL_PASSWORD
    },
    // SMTP connection pool
    pool: true,

    // Number of SMTP connections
    maxConnections: 10,

    // Number of messages per connection
    maxMessages: 100
});

export default transporter;

// export default transporter;
=======
import nodemailer from 'nodemailer';
import dotenv from "dotenv";
dotenv.config();

const transporter = nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: process.env.MAIL_PORT,
    auth: {
      user: process.env.MAIL_USERNAME,
      pass: process.env.MAIL_PASSWORD
    }
});

export default transporter;
>>>>>>> origin/Ajo
