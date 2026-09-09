import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './index.css';
import './App.css';
import { LobbyPage } from './pages/LobbyPage';
import { RoomRoute } from './components/RoomRoute';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LobbyPage />} />
        <Route path="/room/:roomCode" element={<RoomRoute />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);

