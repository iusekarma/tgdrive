import { Navigate, Route, Routes } from "react-router-dom";

import { UploadsProvider } from "./components/uploads";
import VaultGate from "./components/VaultGate";
import BrowserPage from "./pages/BrowserPage";
import DrivesPage from "./pages/DrivesPage";

export default function App() {
  return (
    <UploadsProvider>
      <VaultGate>
        <Routes>
          <Route path="/" element={<DrivesPage />} />
          <Route path="/d/:drive" element={<BrowserPage />} />
          <Route path="/d/:drive/:folderId" element={<BrowserPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </VaultGate>
    </UploadsProvider>
  );
}
