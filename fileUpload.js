import multer from 'multer';
import path from 'path';
import fs from 'fs';

import AWS from 'aws-sdk';
// import { S3Client } from "@aws-sdk/client-s3";
import dotenv from 'dotenv';
dotenv.config();

    // S3 Bucket CODE
    AWS.config.update({
        accessKeyId     : process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey : process.env.AWS_SECRET_ACCESS_KEY,
        region          : process.env.AWS_REGION,
    });
    const s3 = new AWS.S3();
 
    const uploadFileToS3 = async (file, dirName = 'default') => {
        const fileName = `${Date.now()}-${file.originalname}`;
     
        const params = {
            Bucket: process.env.AWS_BUCKET_NAME,
            Key          : `uploads/${dirName}/${fileName}`,
            Body         : file.buffer, //buffer memory directly
            ACL          : 'public-read',
            ContentType  : file.mimetype,
            CacheControl : 'public, max-age=31536000'
        };
        await s3.upload(params).promise();
     
        return fileName;
      };
 

    export const handleFileUpload = ( dirName, fileFields, requiredFields = [], maxFiles = 10, allowedFileTypes = ['pdf', 'png', 'jpeg', 'jpg'] ) => {
        const storage = multer.memoryStorage(); // direct to s3
 
        const fileFilter = (req, file, cb) => {
            const fileExtension = path.extname(file.originalname).slice(1).toLowerCase();
            if (!allowedFileTypes.includes(fileExtension)) {
                return cb(new Error(`Invalid File Type! Only ${allowedFileTypes.join(', ')}`), false);
            }
            cb(null, true);
        };
        const upload = multer({
            storage,
            limits: { fileSize: 10 * 1024 * 1024 }, //10 MB
            fileFilter,
        });
        return (req, res, next) => {
            const multerFields = fileFields.map(field => ({
                name: field,
                maxCount: maxFiles
            }));
            const uploadMethod = upload.fields(multerFields);
     
            uploadMethod(req, res, async (err) => {

                let errorMsg = '';
                if (err) {
                    if (err instanceof multer.MulterError) {
                        errorMsg = err.code === 'LIMIT_FILE_SIZE' ? 'File size should not exceed 10 MB.' : err.message;
                    } else {
                        errorMsg = 'Invalid file. Please upload a JPG, PNG, or PDF.';
                    }
                    return res.json({ status: 0, code: 422, message: [errorMsg] });
                }
                if (!req.files || Object.keys(req.files).length === 0) {
                    return next();
                }
                try {
         
                    for (const field of Object.keys(req.files)) {
                        const originalFiles = req.files[field];
             
                        for (let i = 0; i < originalFiles.length; i++) {
                            const file = originalFiles[i];
                            const s3FileName = await uploadFileToS3(file, dirName);
             
                            file.filename = s3FileName;
                            console.log(" file.filename", file.filename);
                        }
                    }
                    next();
         
                } catch (uploadErr) {
                    console.error(' S3 Upload Error:', uploadErr);
                    return res.status(500).json({ status: 0, message: ['Failed to upload to S3.'] });
                }
            });
        };
    };
 
 
  // s3 image delete process
  export const deleteImageFromS3 = async (oldPath) => {
    if (!oldPath) return;
 
    const decodedFilename = decodeURIComponent(oldPath); // ← Fix here
    const key = `${decodedFilename}`;
 
 
    const params = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
    };
 
    s3.deleteObject(params, (err, data) => {
      if (err) {
        console.error(` Failed to delete image from S3: ${key}`, err);
      } else {
        console.log(` Deleted image from S3: ${key}`);
        //return "deleted image"
      }
    });
  };
