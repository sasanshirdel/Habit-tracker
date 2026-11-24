import {
  CalendarDaysIcon,
  ChartLineIcon,
  CircleCheckBigIcon,
  LayoutDashboardIcon,
  ListTodoIcon,
  NotebookPenIcon,
  SettingsIcon,
  SparklesIcon,
  TargetIcon,
  TimerIcon,
  type LucideIcon,
} from 'lucide-react';
import type { SectionKey } from '@/lib/navigation/sections';

/** One icon per primary section (P1-11). Decorative: links carry their label as text. */
export const sectionIcons: Record<SectionKey, LucideIcon> = {
  overview: LayoutDashboardIcon,
  habits: CircleCheckBigIcon,
  goals: TargetIcon,
  tasks: ListTodoIcon,
  planner: CalendarDaysIcon,
  focus: TimerIcon,
  journal: NotebookPenIcon,
  insights: ChartLineIcon,
  coach: SparklesIcon,
  settings: SettingsIcon,
};
