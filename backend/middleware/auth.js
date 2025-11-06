const jwt = require("jsonwebtoken");
const User = require("../models/user");

const auth = async (req, res, next) => {
    try {
        const token = req.header("Authorization").replace("Bearer ", "");
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findOne({ _id: decoded.userId });

        if (!user) {
            throw new Error();
        }

        req.token = token;
        req.user = user;
        next();
    } catch (error) {
        res.status(401).send({ error: "Please authenticate." });
    }
};

const adminAuth = (req, res, next) => {
    if (req.user.role !== "admin") {
        return res.status(403).send({ error: "Admin access required." });
    }
    next();
};

module.exports = { auth, adminAuth };


