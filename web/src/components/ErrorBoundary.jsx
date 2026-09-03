import { Component } from "react";

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: undefined,
      errorInfo: undefined,
    };
  }

  static getDerivedStateFromError(_error) {
    return { hasError: true };
  }

  componentDidCatch(_error, _errorInfo) {
    // Log error to external service (optional)
    // console.error("Error caught by ErrorBoundary:", _error, _errorInfo);
  }

  render() {
    if (this.state.hasError) {
      // Custom fallbacks (app-level, page-level) get a Retry automatically.
      // Without it a single transient render error latches the screen until
      // a manual browser refresh.
      const retry = () => this.setState({ hasError: false });
      const Fallback = this.props.fallbackComponent || (
        <div className="error-boundary">
          <h3>Something went wrong</h3>
          <p>Please try again or contact support if the issue persists.</p>
        </div>
      );
      return (
        <>
          {Fallback}
          <div style={{ margin: 20 }}>
            <button onClick={retry} className="retry-btn">
              Retry
            </button>
          </div>
        </>
      );
    }
    return this.props.children;
  }
}

ErrorBoundary.defaultProps = {
  fallbackComponent: undefined,
};

export default ErrorBoundary;