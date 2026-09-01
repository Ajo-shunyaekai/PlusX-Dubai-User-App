
import { EventEmitter } from "events";
import transporter from "./mailer.js";

class EmailQueue extends EventEmitter {

    constructor() {
        super();
        this.queue = [];
        this.concurrency = 10;  // Number of emails sent simultaneously
        this.isProcessing = false;
        this.on("enqueueEmail", this.processQueue.bind(this));
    }
    addEmail( toAddress, subject, html, attachment = null, attachments = [] ) {
        this.queue.push({ toAddress, subject, html, attachment, attachments });
        this.emit("enqueueEmail");
    }

    async sendEmail(emailData) {

        const { toAddress, subject, html, attachment, attachments } = emailData;

        try {
            const mailOptions = {
                from: `"The PlusX Electric Team" <media@plusxelectric.com>`,
                to: toAddress,
                subject,
                html
            };
            if (attachment) {
                mailOptions.attachments = [
                    {
                        filename: attachment.filename,
                        path: attachment.path,
                        contentType: attachment.contentType
                    }
                ];
            }
            if (attachments?.length) {
                mailOptions.attachments = attachments;
            }
            await transporter.sendMail(mailOptions);

            console.log(`Email sent to ${toAddress}`);

        } catch (error) {
            console.error( `Failed to send email to ${toAddress}:`, error.message );
        }
    }
    async processQueue() {

        // Already processing
        if (this.isProcessing) return;

        // Nothing to process
        if (this.queue.length === 0) return;

        this.isProcessing = true;

        try {
            const workers = [];
            for (let i = 0; i < this.concurrency; i++) {

                workers.push( this.worker() );
            }
            await Promise.all(workers);

        } finally {

            this.isProcessing = false;

            // In case new emails were added while
            // the workers were finishing
            if (this.queue.length > 0) {
                this.processQueue();
            }
        }
    }
    async worker() {

        while (true) {

            // Get next email
            const emailData = this.queue.shift();

            // Queue empty
            if (!emailData) {
                break;
            }

            await this.sendEmail(emailData);
        }
    }
}
export default new EmailQueue();