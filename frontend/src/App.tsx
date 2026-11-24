import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import AiInsight from './pages/AiInsight';
import Alerts from './pages/Alerts';
import DeviceMonitor from './pages/DeviceMonitor';
import NotFound from './pages/NotFound';
import Overview from './pages/Overview';
import Production from './pages/Production';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/overview" replace />} />
        <Route path="/overview" element={<Overview />} />
        <Route path="/devices" element={<DeviceMonitor />} />
        <Route path="/devices/:deviceId" element={<DeviceMonitor />} />
        <Route path="/production" element={<Production />} />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="/ai" element={<AiInsight />} />
        {/* 未知路径明确报「页面不存在」，不做静默重定向（5.1） */}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
