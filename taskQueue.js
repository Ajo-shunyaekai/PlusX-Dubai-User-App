import PQueue from "p-queue";

// Controls concurrency of I/O operations like DB inserts, API calls
export const taskQueue    = new PQueue({ concurrency: 50 }); // tune based on your DB/API
export const singleQueue = new PQueue({ concurrency: 1 });  // S