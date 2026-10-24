import { Component, type ErrorInfo, type ReactNode } from "react";

/** Contains a rendering error to one panel, so a bug shows a message instead of blanking the window. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: unknown; label: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.label}]`, error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="absolute inset-0 z-40 flex items-center justify-center bg-panel p-6" role="alert" data-testid="error-boundary">
        <div className="max-w-lg space-y-3 text-[13px]">
          <div className="text-[15px] font-semibold">Something went wrong showing the {this.props.label}</div>
          <p className="text-muted">Your staged changes are safe. Try again, and if it keeps happening, copy this message into a bug report:</p>
          <pre className="max-h-40 overflow-auto rounded-md bg-sunken p-2 text-2xs">{String(this.state.error.stack ?? this.state.error)}</pre>
          <button className="rounded-md border border-line px-3 py-1.5 hover:bg-sunken" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      </div>
    );
  }
}
