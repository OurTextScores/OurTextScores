import UploadWorkForm from "./upload-work-form";

export default function UploadWorkPage() {
  return (
    <main className="min-h-screen bg-slate-50 py-12 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto w-full max-w-5xl px-6">
        <UploadWorkForm />
      </div>
    </main>
  );
}
