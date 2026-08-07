import { EventEmitter } from 'events';
import transporter from './mailer.js';

class EmailQueue extends EventEmitter {
    constructor() {
        super();
        this.queue = [];
        this.isProcessing = false;
        this.on('enqueueEmail', this.processQueue.bind(this));
    }  
    addEmail(toAddress, subject, html, attachment = null, attachments = []) {
        this.queue.push({ toAddress, subject, html, attachment, attachments });
        this.emit('enqueueEmail');
    }
    async processQueue() {
        if (this.isProcessing || this.queue.length === 0) return;

        this.isProcessing = true;

        while (this.queue.length > 0) {
            const { toAddress, subject, html, attachment, attachments } = this.queue.shift();
            
            try {
                const mailOptions = {
                    from    : `"The PlusX Electric Team" <media@plusxelectric.com>`,
                    to      : toAddress,
                    subject : subject,
                    html    : html,
                };
                if (attachment) {
                    mailOptions.attachments = [{
                        filename: attachment.filename, path: attachment.path, contentType: attachment.contentType
                    }];
                }
                if(attachments.length){
                    mailOptions.attachments = attachments;
                }
                await transporter.sendMail(mailOptions);
                // console.log(`Email sent to ${toAddress}`);
            } catch (error) {
                console.error(`Failed to send email to ${toAddress}:`, error);
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        this.isProcessing = false; 
    }
}

export default new EmailQueue();
