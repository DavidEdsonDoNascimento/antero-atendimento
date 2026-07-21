import { EmptyState } from "./empty-state";
import { PageHeader } from "./page-header";

export function ComingSoon({
  title,
  description,
  cycle,
  detail,
  icon,
}: {
  title: string;
  description: string;
  cycle: string;
  detail: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="space-y-6">
      <PageHeader title={title} description={description} />
      <EmptyState icon={icon} title={`Em breve — ${cycle}`} description={detail} />
    </div>
  );
}
