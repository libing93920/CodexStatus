import './assets/main.css'
import './assets/themes.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import Island from './island/Island'

const role = new URLSearchParams(window.location.search).get('window')

createRoot(document.getElementById('root')!).render(
  <StrictMode>{role === 'island' ? <Island /> : <App />}</StrictMode>
)
