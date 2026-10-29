import dotenv from "dotenv";
dotenv.config();

export const apiAuthorization = (req, resp, next) => {
  const apiKey = req.headers['authorization'] || req.query.Authorization || req.body.Authorization;
  const token = process.env.API_AUTH_KEY;

  if (!token){
    return resp.status(400).json({message: "Authorization key is misssing", code:400, status:0, data: {}});
  } 

  if (apiKey !== token) {
    return resp.status(403).json({message: 'Access Denied. Invalid Authorization key',code: 403,data: {},status: 0});
  }

  next();
};