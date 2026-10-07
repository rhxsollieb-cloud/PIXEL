import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/tokens.css';
import './ui/pixel.css';
import './workbench.css';

createRoot(document.getElementById('root')!).render(<App />);
