import "dotenv/config";
import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.js";
import healthRouter from "./routes/health.js";
import catalogRoutes from "./routes/catalog.js";
import inventoryRoutes from "./routes/inventory.js";
import orderRoutes from "./routes/orders.js";
import alertRoutes from "./routes/alerts.js";
import reportRoutes from "./routes/reports.js";
import iotRoutes from "./routes/iot.js";
import analyticsRoutes from "./routes/analytics.js";
import expenseRoutes from "./routes/expenses.js";
import excelRoutes from "./routes/excel.js";
import deviceRoutes from "./routes/devices.js";
import eventRoutes from "./routes/events.js";
import { requireAuth } from "./middleware/auth.js";
import { errorHandler, notFound } from "./middleware/error.js";

const app = express();

// LOCAL-ONLY: accept browser calls only from the local web dev server.
const allowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://192.168.1.16:5173",
];
app.use(cors({ origin: allowedOrigins }));

app.use(express.json({ limit: "1mb" }));

app.use("/api/auth", authRoutes);
app.use("/api", catalogRoutes);
app.use("/api", inventoryRoutes);
app.use("/api", orderRoutes);
app.use("/api", alertRoutes);
app.use("/api", reportRoutes);
app.use("/api", iotRoutes);
app.use("/api", analyticsRoutes);
app.use("/api", expenseRoutes);
app.use("/api", excelRoutes);
app.use("/api", deviceRoutes);
// SSE must be registered so its handler is added to the broadcaster.
app.use("/api", eventRoutes);
app.use("/api", healthRouter);

app.use(notFound);
app.use(errorHandler);

// Default stays localhost-only for safety. Set HOST=0.0.0.0 in .env when a
// physical phone on the same Wi-Fi needs to reach the API.
const HOST = process.env.HOST || "127.0.0.1";
const PORT = process.env.PORT || 4000;

app.listen(PORT, HOST, () => {
  console.log(`CartIQ API listening on http://${HOST}:${PORT}${HOST === "127.0.0.1" ? " (localhost only)" : " (LAN-exposed)"}`);
});
