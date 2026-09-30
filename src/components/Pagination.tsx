import { useI18n } from "../i18n";

interface PageNavigationProps {
  page: number;
  pageCount: number;
  total: number;
  loading: boolean;
  onPageChange: (page: number) => void;
  announce?: boolean;
}

export function PageNavigation({ page, pageCount, total, loading, onPageChange, announce = true }: PageNavigationProps) {
  const { t } = useI18n();
  return <div className="pagination-navigation">
    <span role={announce ? "status" : undefined}>{t("Page {page} of {pages} · {total} entries", { page, pages: pageCount, total })}</span>
    <div className="pagination-actions">
      <button type="button" className="button button--quiet" aria-label={t("First page")} disabled={loading || page === 1} onClick={() => onPageChange(1)}>«</button>
      <button type="button" className="button button--quiet" aria-label={t("Previous page")} disabled={loading || page === 1} onClick={() => onPageChange(page - 1)}>‹</button>
      <button type="button" className="button button--quiet" aria-label={t("Next page")} disabled={loading || page >= pageCount} onClick={() => onPageChange(page + 1)}>›</button>
      <button type="button" className="button button--quiet" aria-label={t("Last page")} disabled={loading || page >= pageCount} onClick={() => onPageChange(pageCount)}>»</button>
    </div>
  </div>;
}
