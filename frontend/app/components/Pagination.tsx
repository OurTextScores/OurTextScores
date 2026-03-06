/*
 * Copyright (C) 2025 OurTextScores Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

interface PaginationProps {
    currentPage: number;
    totalItems: number;
    itemsPerPage: number;
    onPageChange: (page: number) => void;
    itemLabel?: string;
    afterTotalText?: string;
}

export default function Pagination({
    currentPage,
    totalItems,
    itemsPerPage,
    onPageChange,
    itemLabel = "results",
    afterTotalText,
}: PaginationProps) {
    const totalPages = Math.ceil(totalItems / itemsPerPage);

    // Don't show pagination if there's only one page or no items
    if (totalPages <= 1) {
        return null;
    }

    const canGoPrevious = currentPage > 1;
    const canGoNext = currentPage < totalPages;

    return (
        <div className="flex items-center justify-between border-t border-stone-200/80 bg-transparent px-5 py-4 dark:border-slate-800">
            <div className="flex flex-1 justify-between sm:hidden">
                <button
                    onClick={() => onPageChange(currentPage - 1)}
                    disabled={!canGoPrevious}
                    className="ots-button-secondary disabled:cursor-not-allowed disabled:opacity-50"
                >
                    Previous
                </button>
                <button
                    onClick={() => onPageChange(currentPage + 1)}
                    disabled={!canGoNext}
                    className="ots-button-secondary relative ml-3 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    Next
                </button>
            </div>
            <div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
                <div>
                    <p className="text-sm text-slate-700 dark:text-slate-300">
                        Showing{' '}
                        <span className="font-medium">
                            {Math.min((currentPage - 1) * itemsPerPage + 1, totalItems)}
                        </span>{' '}
                        to{' '}
                        <span className="font-medium">
                            {Math.min(currentPage * itemsPerPage, totalItems)}
                        </span>{' '}
                        of <span className="font-medium">{totalItems}</span> {itemLabel}
                        {afterTotalText}
                    </p>
                </div>
                <div>
                    <nav className="isolate inline-flex gap-1 rounded-full border border-stone-200/80 bg-white/90 p-1 shadow-sm dark:border-slate-700 dark:bg-slate-900/80" aria-label="Pagination">
                        <button
                            onClick={() => onPageChange(currentPage - 1)}
                            disabled={!canGoPrevious}
                            className="relative inline-flex items-center rounded-full px-3 py-2 text-sm font-medium text-slate-500 hover:bg-stone-100 focus:z-20 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800"
                        >
                            <span className="sr-only">Previous</span>
                            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                                <path fillRule="evenodd" d="M12.79 5.23a.75.75 0 01-.02 1.06L8.832 10l3.938 3.71a.75.75 0 11-1.04 1.08l-4.5-4.25a.75.75 0 010-1.08l4.5-4.25a.75.75 0 011.06.02z" clipRule="evenodd" />
                            </svg>
                        </button>

                        {/* Page numbers */}
                        {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                            let pageNum: number;

                            // Smart page number display logic
                            if (totalPages <= 7) {
                                pageNum = i + 1;
                            } else if (currentPage <= 4) {
                                pageNum = i + 1;
                            } else if (currentPage >= totalPages - 3) {
                                pageNum = totalPages - 6 + i;
                            } else {
                                pageNum = currentPage - 3 + i;
                            }

                            return (
                                <button
                                    key={pageNum}
                                    onClick={() => onPageChange(pageNum)}
                                    className={`relative inline-flex items-center rounded-full px-4 py-2 text-sm font-medium focus:z-20 ${currentPage === pageNum
                                            ? 'z-10 bg-slate-900 text-white dark:bg-sky-300 dark:text-slate-950'
                                            : 'text-slate-700 hover:bg-stone-100 dark:text-slate-200 dark:hover:bg-slate-800'
                                        }`}
                                >
                                    {pageNum}
                                </button>
                            );
                        })}

                        <button
                            onClick={() => onPageChange(currentPage + 1)}
                            disabled={!canGoNext}
                            className="relative inline-flex items-center rounded-full px-3 py-2 text-sm font-medium text-slate-500 hover:bg-stone-100 focus:z-20 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800"
                        >
                            <span className="sr-only">Next</span>
                            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                                <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
                            </svg>
                        </button>
                    </nav>
                </div>
            </div>
        </div>
    );
}
