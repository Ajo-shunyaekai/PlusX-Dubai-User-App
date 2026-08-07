import logger from "../logger.js";

export const errorHandler = (err, req, res, next) => {

    const message = "Oops! There is something went wrong! Please Try Again.";
    try {
        const stack = err?.stack || "";
        const arrE = stack.split(",");

        let errorLocation = "Stack unavailable";
        if (arrE.length && typeof arrE[0] === "string") {
            const lineArr = arrE[0].split("at");
            errorLocation = (lineArr.length > 1) ? lineArr[1].trim() : arrE[0].trim();
        }
        logger.error(`${err} at (${errorLocation}) On (${req.originalUrl})`);
        return res.json({ status: 0, code: err?.statusCode || 500, message: [message] });

    } catch (error) {
        // Fallback if error handler itself crashes
        logger.error(`Error in error-handler: ${error}`);
        return res.json({ status: 0, code: err?.statusCode || 500, message: [message] });
    }
};

export const tryCatchErrorHandler = (action, err, res, msg='' ) => {

    const message = msg || "Oops! There is something went wrong! Please Try Again!";
    try {
        const stack = err?.stack || "";
        let arrE    = stack.split(",");

        if (arrE.length > 0 && arrE[0]) {
            let lineArr = arrE[0].split("at");

            if (lineArr.length > 1) {
                logger.error(` ${err} at (${lineArr[1].trim()}) On (${action})`);
            } else {
                logger.error(` ${err} at (${arrE[0].trim()}) On (${action})`);
            }
        } else {
            logger.error(`Error : ${err} On (${action})`);
        }
        if (res && typeof res.json === "function") {
            return res.json({ status: 0, code: err?.statusCode || 500, message: [message] });
        }
        return false;

    } catch (error) {
        logger.error(`Error in error-handler: ${error}`);
        if (res && typeof res.json === "function") {
            return res.json({ status: 0, code: err?.statusCode || 500, message: [message] });
        }
        return false;
    }
};
