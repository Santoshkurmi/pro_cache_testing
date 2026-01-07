import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ProCacheProvider } from '../../../pro_cache/src/react'
import { cache } from './cache'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ProCacheProvider client={cache}>
        <App />
    </ProCacheProvider>
  </StrictMode>,
)
