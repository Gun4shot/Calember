import { Component, type ReactNode } from "react";

// Keeps one failing view from blanking the whole app; shows a short message instead.
export class ErrorBoundary extends Component<{ children: ReactNode; label: string }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
  componentDidCatch(e: unknown) {
    console.error(`[${this.props.label}]`, e);
  }
  render() {
    if (this.state.err)
      return (
        <div className="note" role="alert">
          The {this.props.label} could not be shown ({this.state.err}).{" "}
          <button type="button" className="btn btn-small btn-ghost" onClick={() => this.setState({ err: null })}>
            Try again
          </button>
        </div>
      );
    return this.props.children;
  }
}
