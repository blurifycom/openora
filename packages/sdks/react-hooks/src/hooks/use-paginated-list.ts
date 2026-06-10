'use client';

import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';

const DEFAULT_PAGE_SIZE = 20;

export type PaginatedListState<T> = {
  items: T[];
  total: number;
  page: number;
  setPage: (page: number) => void;
  search: string;
  setSearch: (search: string) => void;
  isLoading: boolean;
  totalPages: number;
};

export function usePaginatedList<T>(opts: {
  queryKey: unknown[];
  queryFn: (page: number, search: string) => Promise<{ items: T[]; total: number }>;
  pageSize?: number;
}): PaginatedListState<T> {
  const { queryKey, queryFn, pageSize = DEFAULT_PAGE_SIZE } = opts;
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: [...queryKey, { page, search }],
    queryFn: () => queryFn(page, search),
    placeholderData: keepPreviousData,
  });

  const total = data?.total ?? 0;

  function handleSetSearch(s: string) {
    setSearch(s);
    setPage(1);
  }

  return {
    items: data?.items ?? [],
    total,
    page,
    setPage,
    search,
    setSearch: handleSetSearch,
    isLoading,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
