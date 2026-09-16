export default function ConversasLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Carregando conversas">
      <div className="h-8 w-40 animate-pulse rounded-md bg-surface-2" />
      <div className="grid grid-cols-1 overflow-hidden rounded-lg border border-line bg-surface md:h-[calc(100vh-13rem)] md:min-h-[480px] md:grid-cols-[22rem_1fr]">
        <div className="flex flex-col gap-2 border-line p-3 md:border-r">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="h-16 animate-pulse rounded-md bg-surface-2" />
          ))}
        </div>
        <div className="hidden flex-col items-center justify-center p-6 md:flex">
          <div className="h-40 w-2/3 animate-pulse rounded-md bg-surface-2" />
        </div>
      </div>
    </div>
  );
}
