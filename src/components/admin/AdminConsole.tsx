import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BookOpenCheck,
  Building2,
  ClipboardList,
  Database,
  LogOut,
  Menu,
  Printer,
  Shield,
  Unlock,
  Users,
  X,
} from 'lucide-react';
import type {
  AdminTabKey,
  ExamResult,
  ExamSchedule,
  Participant,
  Question,
  SchoolProfile,
  StaffAccount,
} from '@/src/types/cbt';
import { AdminBrandingTab } from '@/src/components/admin/AdminBrandingTab';
import { AdminDashboardTab } from '@/src/components/admin/AdminDashboardTab';
import { AdminDatabaseTab } from '@/src/components/admin/AdminDatabaseTab';
import { AdminExamCardsTab } from '@/src/components/admin/AdminExamCardsTab';
import { AdminParticipantsTab } from '@/src/components/admin/AdminParticipantsTab';
import { AdminQuestionsTab } from '@/src/components/admin/AdminQuestionsTab';
import { AdminRecapTab } from '@/src/components/admin/AdminRecapTab';
import { AdminResetExamTab } from '@/src/components/admin/AdminResetExamTab';
import { AdminRolesTab } from '@/src/components/admin/AdminRolesTab';

interface AdminConsoleProps {
  profile: SchoolProfile;
  currentStaff: StaffAccount;
  staffAccounts: StaffAccount[];
  participants: Participant[];
  schedules: ExamSchedule[];
  questions: Question[];
  results: ExamResult[];
  hiddenDashboardLogs: Record<string, string>;
  isSyncing: boolean;
  onForceSync: () => Promise<void>;
  onSaveProfile: (
    updated: SchoolProfile,
    options?: { updateAdminPassword?: boolean }
  ) => Promise<{ synced: boolean; error?: string } | void>;
  onUpsertParticipants: (items: Participant[]) => Promise<void>;
  onDeleteParticipant: (id: string) => Promise<void>;
  onDeleteAllParticipants: () => Promise<void>;
  onSaveSchedule: (schedule: ExamSchedule) => Promise<{ synced: boolean; error?: string } | void>;
  onDeleteSchedule: (id: string) => Promise<{ synced: boolean; error?: string } | void>;
  onDeleteAllSchedules: (allowedSubjects?: string[]) => Promise<void>;
  onUpsertQuestions: (items: Question[]) => Promise<{ synced: boolean; error?: string } | void>;
  onDeleteQuestion: (id: string) => Promise<{ synced: boolean; error?: string } | void>;
  onDeleteQuestionsBatch: (ids: string[]) => Promise<void>;
  onDeleteAllQuestions: (allowedSubjects?: string[]) => Promise<void>;
  onForceFinishExamResults: (resultIds: string[]) => Promise<number>;
  onHideDashboardLogs: (items: Array<{ id: string; startedAt: string }>) => Promise<void>;
  onClearDashboardLogs: () => Promise<void>;
  onResetExamResults: (resultIds: string[]) => Promise<void>;
  onUpsertStaff: (
    account: StaffAccount,
    options?: { updatePassword?: boolean }
  ) => Promise<{ synced: boolean; error?: string } | void>;
  onDeleteStaff: (id: string) => Promise<{ synced: boolean; error?: string } | void>;
  onRefreshAll: () => Promise<void>;
  onExitAdmin: () => void;
}

const NAV_ITEMS: {
  key: AdminTabKey;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { key: 'dashboard', label: 'Dashboard Ujian', icon: Activity },
  { key: 'reset', label: 'Reset & Buka Kunci', icon: Unlock },
  { key: 'recap', label: 'Rekap Nilai', icon: ClipboardList },
  { key: 'branding', label: 'Profil Lembaga', icon: Building2 },
  { key: 'participants', label: 'Peserta & Token', icon: Users },
  { key: 'questions', label: 'Bank Soal & Mapel', icon: BookOpenCheck },
  { key: 'cards', label: 'Cetak Kartu Ujian', icon: Printer },
  { key: 'roles', label: 'Role & Hak Akses', icon: Shield },
  { key: 'database', label: 'Database & SQL', icon: Database },
];

export const AdminConsole: React.FC<AdminConsoleProps> = ({
  profile,
  currentStaff,
  staffAccounts,
  participants,
  schedules,
  questions,
  results,
  hiddenDashboardLogs,
  isSyncing,
  onForceSync,
  onSaveProfile,
  onUpsertParticipants,
  onDeleteParticipant,
  onDeleteAllParticipants,
  onSaveSchedule,
  onDeleteSchedule,
  onDeleteAllSchedules,
  onUpsertQuestions,
  onDeleteQuestion,
  onDeleteQuestionsBatch,
  onDeleteAllQuestions,
  onForceFinishExamResults,
  onHideDashboardLogs,
  onClearDashboardLogs,
  onResetExamResults,
  onUpsertStaff,
  onDeleteStaff,
  onRefreshAll,
  onExitAdmin,
}) => {
  const visibleNavItems = useMemo(
    () => NAV_ITEMS.filter((item) => currentStaff.allowedTabs.includes(item.key)),
    [currentStaff.allowedTabs]
  );

  const [activeTab, setActiveTab] = useState<AdminTabKey>(
    () => visibleNavItems[0]?.key || 'dashboard'
  );
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    if (visibleNavItems.length > 0 && !visibleNavItems.some((item) => item.key === activeTab)) {
      setActiveTab(visibleNavItems[0].key);
    }
  }, [visibleNavItems, activeTab]);

  const activeNav = visibleNavItems.find((n) => n.key === activeTab) || visibleNavItems[0];
  const restrictedSubjects = currentStaff.restrictToAssignedSubjects
    ? currentStaff.assignedSubjects
    : undefined;

  const renderSidebarContent = () => (
    <div className="flex flex-col h-full">
      <div className="px-5 py-5 border-b border-emerald-900/30 flex items-center gap-3.5">
        {profile.logoDataUrl && (
          <img
            src={profile.logoDataUrl}
            alt={`Logo ${profile.schoolName}`}
            referrerPolicy="no-referrer"
            className="w-14 h-14 object-contain shrink-0"
          />
        )}
        <div className="min-w-0">
          <div className="font-display font-bold text-sm text-white truncate">
            {profile.schoolName}
          </div>
          <div className="text-xs text-emerald-100/90 font-medium truncate">
            {currentStaff.name}
          </div>
          <div className="text-[11px] text-emerald-200/80 font-mono truncate">
            {currentStaff.roleLabel} · {currentStaff.userId}
          </div>
        </div>
      </div>

      <nav className="flex-1 p-3 space-y-1 overflow-y-auto" aria-label="Menu Admin">
        {visibleNavItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                setActiveTab(item.key);
                setMobileMenuOpen(false);
              }}
              className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors cursor-pointer whitespace-nowrap ${
                isActive
                  ? 'bg-white text-[#064e3b] font-semibold shadow-xs'
                  : 'text-emerald-100/85 hover:bg-white/10 hover:text-white'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="p-3 border-t border-emerald-900/30">
        <button
          type="button"
          onClick={onExitAdmin}
          className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium text-emerald-100 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
        >
          <LogOut className="w-4 h-4 shrink-0" />
          <span>Halaman Login Siswa</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Desktop Sidebar — hidden automatically in @media print */}
      <aside className="no-print hidden lg:flex lg:w-[270px] lg:flex-col lg:fixed lg:inset-y-0 bg-[#064e3b] text-white z-30">
        {renderSidebarContent()}
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="no-print fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/60"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative w-72 max-w-[85vw] bg-[#064e3b] text-white flex flex-col z-10">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              className="absolute top-4 right-4 p-1.5 rounded-lg text-emerald-100 hover:bg-white/10 cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
            {renderSidebarContent()}
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 lg:pl-[270px] print:pl-0 flex flex-col min-w-0">
        {/* Top Breadcrumb Header — hidden automatically in @media print */}
        <header className="no-print sticky top-0 z-20 bg-white border-b border-slate-200 h-16 px-4 sm:px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-50 cursor-pointer"
              aria-label="Buka menu navigasi"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm text-slate-500 min-w-0">
              <span className="hidden sm:inline truncate">{profile.schoolName}</span>
              <span className="hidden sm:inline text-slate-300" aria-hidden="true">
                /
              </span>
              <span className="font-semibold text-slate-900 truncate">
                {activeNav?.label || 'Portal Admin'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <span className="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs font-semibold">
              <span>{currentStaff.roleLabel}</span>
              <span className="text-emerald-600">·</span>
              <span className="font-mono">{currentStaff.userId}</span>
            </span>

            <button
              type="button"
              onClick={onExitAdmin}
              className="px-3.5 py-2 rounded-xl border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap"
            >
              Keluar ke Login Siswa
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 print:p-0">
          {activeTab === 'dashboard' && currentStaff.allowedTabs.includes('dashboard') && (
            <AdminDashboardTab
              participants={participants}
              schedules={schedules}
              results={results}
              hiddenDashboardLogs={hiddenDashboardLogs}
              allowedSubjects={restrictedSubjects}
              onForceSync={onForceSync}
              isSyncing={isSyncing}
              onForceFinishResults={onForceFinishExamResults}
              onHideDashboardLogs={onHideDashboardLogs}
              onClearDashboardLogs={onClearDashboardLogs}
              onNavigateToReset={
                currentStaff.allowedTabs.includes('reset')
                  ? () => setActiveTab('reset')
                  : undefined
              }
            />
          )}

          {activeTab === 'reset' && currentStaff.allowedTabs.includes('reset') && (
            <AdminResetExamTab
              schedules={schedules}
              results={results}
              allowedSubjects={restrictedSubjects}
              onResetExamResults={onResetExamResults}
            />
          )}

          {activeTab === 'recap' && currentStaff.allowedTabs.includes('recap') && (
            <AdminRecapTab
              profile={profile}
              participants={participants}
              schedules={schedules}
              questions={questions}
              results={results}
              staffRoleType={currentStaff.roleType}
              staffName={currentStaff.name}
              allowedSubjects={restrictedSubjects}
              onForceSync={onForceSync}
              isSyncing={isSyncing}
              onDeleteResults={onResetExamResults}
            />
          )}

          {activeTab === 'branding' && currentStaff.allowedTabs.includes('branding') && (
            <AdminBrandingTab profile={profile} onSaveProfile={onSaveProfile} />
          )}

          {activeTab === 'participants' && currentStaff.allowedTabs.includes('participants') && (
            <AdminParticipantsTab
              participants={participants}
              onUpsertParticipants={onUpsertParticipants}
              onDeleteParticipant={onDeleteParticipant}
              onDeleteAllParticipants={onDeleteAllParticipants}
            />
          )}

          {activeTab === 'questions' && currentStaff.allowedTabs.includes('questions') && (
            <AdminQuestionsTab
              schedules={schedules}
              questions={questions}
              participants={participants}
              results={results}
              staffRoleType={currentStaff.roleType}
              allowedSubjects={restrictedSubjects}
              onSaveSchedule={onSaveSchedule}
              onDeleteSchedule={onDeleteSchedule}
              onDeleteAllSchedules={onDeleteAllSchedules}
              onUpsertQuestions={onUpsertQuestions}
              onDeleteQuestion={onDeleteQuestion}
              onDeleteQuestionsBatch={onDeleteQuestionsBatch}
              onDeleteAllQuestions={onDeleteAllQuestions}
            />
          )}

          {activeTab === 'cards' && currentStaff.allowedTabs.includes('cards') && (
            <AdminExamCardsTab profile={profile} participants={participants} />
          )}

          {activeTab === 'roles' && currentStaff.allowedTabs.includes('roles') && (
            <AdminRolesTab
              staffAccounts={staffAccounts}
              currentStaffId={currentStaff.id}
              schedules={schedules}
              questions={questions}
              onUpsertStaff={onUpsertStaff}
              onDeleteStaff={onDeleteStaff}
            />
          )}

          {activeTab === 'database' && currentStaff.allowedTabs.includes('database') && (
            <AdminDatabaseTab onDatabaseChanged={onRefreshAll} />
          )}
        </main>
      </div>
    </div>
  );
};
