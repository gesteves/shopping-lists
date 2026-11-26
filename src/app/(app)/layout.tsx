import { SessionRefresh } from "../session-refresh";

// The signed-in part of the app. Ticket #8 adds the shell.
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <SessionRefresh />
      {children}
    </>
  );
}
