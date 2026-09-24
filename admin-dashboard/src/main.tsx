import { createRoot } from 'react-dom/client';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import App from './App';
import './styles.css';
import 'leaflet/dist/leaflet.css';
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* Do not log private records or credentials. */ }
  render() { return this.state.failed ? <main className="boot"><h1>Unable to display this workspace</h1><p>Reload to reconnect securely. If the issue continues, contact your administrator.</p><button className="button primary" onClick={() => location.reload()}>Reload workspace</button></main> : this.props.children; }
}
createRoot(document.getElementById('root')!).render(<Boundary><App /></Boundary>);
