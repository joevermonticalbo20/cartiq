import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, EyeOff } from "lucide-react";
import api from "../api.js";

export default function Login() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { data } = await api.post("/auth/login", { username, password });
      localStorage.setItem("cartiq_token", data.token);
      navigate("/dashboard");
    } catch (err) {
      setError(err.response?.data?.error || "Login failed. Is the API running?");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="center-wrap">
      <form
        className="card login-card"
        onSubmit={handleSubmit}
        aria-label="Sign in to CartIQ"
      >
        <h1>CartIQ</h1>
        <p className="muted">Pota Fries Admin Dashboard</p>
        <label htmlFor="login-username" className="field">
          Username
          <input
            id="login-username"
            name="username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            autoComplete="username"
            autoFocus
            required
          />
        </label>
        <label htmlFor="login-password" className="field">
          Password
          <div className="password-field">
            <input
              id="login-password"
              name="password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
            />
            <button
              type="button"
              className="ghost icon-only password-toggle"
              onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              title={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
        </label>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <button disabled={loading}>{loading ? "Signing in..." : "Sign in"}</button>
        <p className="muted small">Local development - owner/owner123</p>
      </form>
    </div>
  );
}