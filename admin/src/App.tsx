import React from 'react';
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Outlet } from
'react-router-dom';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ToastProvider } from './contexts/ToastContext';
import DashboardLayout from './components/layout/DashboardLayout';
// Pages
import { Login } from './pages/Login';
import { Profile } from './pages/Profile';
import { Dashboard } from './pages/Dashboard';
import { Users } from './pages/Users';
import { UserDetails } from './pages/UserDetails';
import { CreatorApplications } from './pages/CreatorApplications';
import { ApplicationDetails } from './pages/ApplicationDetails';
import { ContentRemovalApplications } from './pages/ContentRemovalApplications';
import { Videos } from './pages/Videos';
import { LiveSessions } from './pages/LiveSessions';
import { LiveSessionDetails } from './pages/LiveSessionDetails';
import { LiveSessionViewer } from './pages/LiveSessionViewer';
import { RandomSessions } from './pages/RandomSessions';
import { RandomSessionDetails } from './pages/RandomSessionDetails';
import { PremiumVideos } from './pages/PremiumVideos';
import { Creators } from './pages/Creators';
import { MembershipPlans } from './pages/MembershipPlans';
import { CoinManagement } from './pages/CoinManagement';
import { Payments } from './pages/Payments';
import { CreatorPayouts } from './pages/CreatorPayouts';
import { AuditLogs } from './pages/AuditLogs';
import { AdminRoles } from './pages/AdminRoles';
import { Settings } from './pages/Settings';
// New Pages
import { AIModerator } from './pages/AIModerator';
import { AIModerationSession } from './pages/AIModerationSession';
import { FinanceHub } from './pages/FinanceHub';
import { TermsPolicy } from './pages/TermsPolicy';
import { AdsManagement } from './pages/AdsManagement';
import { EnvSettings } from './pages/EnvSettings';
import { ExternalFeedSettings } from './pages/ExternalFeedSettings';
import { ITOperations } from './pages/ITOperations';
import { Unauthorized } from './pages/Unauthorized';
import { InviteComplete } from './pages/InviteComplete';
function ProtectedRoute({ children }: {children: React.ReactNode;}) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function PermissionRoute({ path, children }: { path: string; children: React.ReactNode }) {
  const { hasPermission } = useAuth();
  if (!hasPermission(path)) return <Navigate to="/unauthorized" replace />;
  return <>{children}</>;
}
export function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/invite/complete" element={<InviteComplete />} />
            <Route path="/unauthorized" element={<Unauthorized />} />

            <Route
              path="/"
              element={
              <ProtectedRoute>
                  <DashboardLayout />
                </ProtectedRoute>
              }>
              
              <Route index element={<PermissionRoute path="/"><Dashboard /></PermissionRoute>} />
              <Route path="profile" element={<PermissionRoute path="/"><Profile /></PermissionRoute>} />
              <Route path="users" element={<PermissionRoute path="/users"><Users /></PermissionRoute>} />
              <Route path="users/:id" element={<PermissionRoute path="/users"><UserDetails /></PermissionRoute>} />
              <Route path="creators" element={<PermissionRoute path="/creators"><Creators /></PermissionRoute>} />
              <Route
                path="creator-applications"
                element={<PermissionRoute path="/creator-applications"><CreatorApplications /></PermissionRoute>} />
              
              <Route
                path="creator-applications/:id"
                element={<PermissionRoute path="/creator-applications"><ApplicationDetails /></PermissionRoute>} />
              
              <Route path="videos" element={<PermissionRoute path="/videos"><Videos /></PermissionRoute>} />
              <Route path="premium-videos" element={<PermissionRoute path="/premium-videos"><PremiumVideos /></PermissionRoute>} />
              <Route path="live-sessions" element={<PermissionRoute path="/live-sessions"><LiveSessions /></PermissionRoute>} />
              <Route
                path="live-sessions/:id"
                element={<PermissionRoute path="/live-sessions"><LiveSessionDetails /></PermissionRoute>} />
              
              <Route
                path="live-sessions/:id/watch"
                element={<PermissionRoute path="/live-sessions"><LiveSessionViewer /></PermissionRoute>} />
              
              <Route path="random-sessions" element={<PermissionRoute path="/random-sessions"><RandomSessions /></PermissionRoute>} />
              <Route
                path="random-sessions/:id"
                element={<PermissionRoute path="/random-sessions"><RandomSessionDetails /></PermissionRoute>} />
              
              <Route path="content-removal" element={<PermissionRoute path="/content-removal"><ContentRemovalApplications /></PermissionRoute>} />
              <Route path="membership-plans" element={<PermissionRoute path="/membership-plans"><MembershipPlans /></PermissionRoute>} />
              <Route path="coin-management" element={<PermissionRoute path="/coin-management"><CoinManagement /></PermissionRoute>} />
              <Route path="payments" element={<PermissionRoute path="/payments"><Payments /></PermissionRoute>} />
              <Route path="creator-payouts" element={<PermissionRoute path="/creator-payouts"><CreatorPayouts /></PermissionRoute>} />
              <Route path="audit-logs" element={<PermissionRoute path="/audit-logs"><AuditLogs /></PermissionRoute>} />
              <Route path="admin-roles" element={<PermissionRoute path="/admin-roles"><AdminRoles /></PermissionRoute>} />
              <Route path="settings" element={<PermissionRoute path="/settings"><Settings /></PermissionRoute>} />
              <Route path="external-feed" element={<PermissionRoute path="/external-feed"><ExternalFeedSettings /></PermissionRoute>} />

              <Route path="ai-moderator" element={<PermissionRoute path="/ai-moderator"><AIModerator /></PermissionRoute>} />
              <Route path="ai-moderator/sessions/:sessionId" element={<PermissionRoute path="/ai-moderator"><AIModerationSession /></PermissionRoute>} />
              <Route path="finance-hub" element={<PermissionRoute path="/finance-hub"><FinanceHub /></PermissionRoute>} />
              <Route path="terms-policy" element={<PermissionRoute path="/terms-policy"><TermsPolicy /></PermissionRoute>} />
              <Route path="ads-management" element={<PermissionRoute path="/ads-management"><AdsManagement /></PermissionRoute>} />
              <Route path="env-settings" element={<PermissionRoute path="/env-settings"><EnvSettings /></PermissionRoute>} />
              <Route path="it-operations" element={<PermissionRoute path="/it-operations"><ITOperations /></PermissionRoute>} />
            </Route>
          </Routes>
        </BrowserRouter>
        </ToastProvider>
      </AuthProvider>
    </ThemeProvider>);

}
