import { createRoot } from 'react-dom/client'
import SessionCleanerApp from './App'
import './reference/base.css'
import './reference/investment.css'
import './reference/compact.css'
import './reference-library.css'
import './reference-integration.css'
import './reference-motion.css'
import './session-cleaner-manager.css'
import './session-cleaner-manager-pages.css'
import './session-cleaner-calm.css'
import './session-cleaner-calm-library.css'
import './session-cleaner-polish.css'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('会话清理页面缺少 root 容器')

createRoot(rootElement).render(<SessionCleanerApp />)
