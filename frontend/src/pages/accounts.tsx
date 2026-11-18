import { useState } from 'react'
import { formatAccountMask, getAccountLabel, getAccountName } from '@/lib/account-utils'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useDisplayLocale } from '@/hooks/use-display-locale'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { accounts, assets, currencies } from '@/lib/api'
import { localDateString } from '@/lib/date-utils'
import { invalidateFinancialQueries } from '@/lib/invalidate-queries'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { DatePickerInput } from '@/components/ui/date-picker-input'
import { Skeleton } from '@/components/ui/skeleton'
import type { Account, LoanAmortization, LoanRatePeriod } from '@/types'
import { AccountIcon } from '@/components/account-icon'
import { getAccountTypeConfig } from '@/lib/account-type-config'
import { AccountPageActions } from '@/components/account-page-actions'
import { AccountRowActions } from '@/components/account-row-actions'
import { PageHeader } from '@/components/page-header'
import { PageRefreshButton } from '@/components/page-refresh-button'
import { SyncAllConnectionsButton } from '@/components/sync-all-connections-button'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { useAuth } from '@/contexts/auth-context'
import { useCollectionFilter } from '@/contexts/collection-filter-context'
import { useWorkspace } from '@/contexts/workspace-context'
import { formatCurrency } from '@/lib/format'
import { LOAN_COLLATERAL_TYPES } from '@/lib/property-equity'

// Account types offered in the create/edit dialog. Shared between the manual
// type selector and the connected-account override selector so the list stays
// in one place.
const ACCOUNT_TYPE_OPTIONS = [
  { value: 'checking', labelKey: 'accounts.typeChecking' },
  { value: 'savings', labelKey: 'accounts.typeSavings' },
  { value: 'credit_card', labelKey: 'accounts.typeCreditCard' },
  { value: 'loan', labelKey: 'accounts.typeLoan' },
  { value: 'investment', labelKey: 'accounts.typeInvestment' },
  { value: 'wallet', labelKey: 'accounts.typeWallet' },
] as const

export default function AccountsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const locale = useDisplayLocale()
  const { mask } = usePrivacyMode()
  const { user } = useAuth()
  const { activeAccountIds } = useCollectionFilter()
  const { canWrite } = useWorkspace()
  // The "Viewing" bar sits directly above this page, so its scope has to reach
  // the lists too — the sidebar was already filtered, this page was not.
  // null = no active collection = every account.
  const inActiveCollection = (a: Account) => !activeAccountIds || activeAccountIds.includes(a.id)
  const userCurrency = user?.preferences?.currency_display ?? 'USD'
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [closingAccountId, setClosingAccountId] = useState<string | null>(null)

  const { data: accountsList, isLoading, isFetching: accountsFetching } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => accounts.list(),
  })

  const { data: closedAccountsList } = useQuery({
    queryKey: ['accounts', 'closed'],
    queryFn: () => accounts.list(true),
  })
  // Credit cards live on their own page (/cards) and bank links on /connections.
  const closedAccounts = closedAccountsList?.filter((a) => a.is_closed && a.type !== 'credit_card' && inActiveCollection(a)) ?? []

  const createMutation = useMutation({
    mutationFn: (data: { name: string; type: string; balance?: number; currency?: string }) =>
      accounts.create(data),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      setDialogOpen(false)
      toast.success(t('accounts.created'))
    },
    onError: () => toast.error(t('common.error')),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: Partial<Account> & { id: string }) =>
      accounts.update(id, data),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      setDialogOpen(false)
      setEditingAccount(null)
      toast.success(t('accounts.updated'))
    },
    onError: (_err, variables) => {
      const original = editingAccount?.type
      const crossesLoan = !!original && !!variables.type && variables.type !== original
        && (variables.type === 'loan' || original === 'loan')
      toast.error(crossesLoan ? t('accounts.loanRetypeBlocked') : t('common.error'))
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => accounts.delete(id),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      queryClient.invalidateQueries({ queryKey: ['import-logs'] })
      setDeletingId(null)
      toast.success(t('accounts.deleted'))
    },
    onError: () => toast.error(t('common.error')),
  })

  const closeMutation = useMutation({
    mutationFn: (id: string) => accounts.close(id),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      setClosingAccountId(null)
      toast.success(t('accounts.accountClosed'))
    },
    onError: () => toast.error(t('common.error')),
  })

  const reopenMutation = useMutation({
    mutationFn: (id: string) => accounts.reopen(id),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      toast.success(t('accounts.accountReopened'))
    },
    onError: () => toast.error(t('common.error')),
  })

  const listedAccounts = accountsList?.filter((a) => a.type !== 'credit_card' && inActiveCollection(a)) ?? []

  return (
    <div className="space-y-6">
      <PageHeader
        section={t('accounts.title')}
        title={t('accounts.title')}
        action={
          <div className="flex items-center gap-2">
            <PageRefreshButton
              onRefresh={() => queryClient.refetchQueries({ type: 'active' })}
              refreshing={accountsFetching}
            />
            <SyncAllConnectionsButton />
            <AccountPageActions
              canWrite={canWrite}
              onAddAccount={() => { setEditingAccount(null); setDialogOpen(true) }}
              onOpenCollections={() => navigate('/collections')}
            />
          </div>
        }
      />

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
        </div>
      ) : (
        <div className="space-y-6">
          <div className="bg-card rounded-xl border border-border shadow-sm">
            {listedAccounts.length > 0 ? (
              <div className="divide-y divide-muted">
                {listedAccounts.map((acc) => {
                  const cfg = getAccountTypeConfig(acc.type)
                  const bal = Number(acc.current_balance)
                  const accountMask = formatAccountMask(acc)
                  return (
                    <div key={acc.id} className="group flex items-center px-5 py-3 hover:bg-muted/50 transition-colors">
                      <Link to={`/accounts/${acc.id}`} className="flex items-center gap-3 flex-1 min-w-0">
                        <AccountIcon account={acc} />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-foreground truncate">{getAccountName(acc)}</p>
                          <p className="text-xs text-muted-foreground">
                            {t(cfg.label)}
                            {accountMask && <> · <span className="tabular-nums">{accountMask}</span></>}
                          </p>
                        </div>
                      </Link>
                      <div className="shrink-0 text-right">
                        <p className={`text-xs sm:text-sm font-semibold tabular-nums ${bal < 0 ? 'text-rose-500' : 'text-foreground'}`}>
                          {mask(formatCurrency(bal, acc.currency, locale))}
                        </p>
                        {acc.balance_primary != null && acc.currency !== userCurrency && (
                          <p className="text-[10px] text-muted-foreground tabular-nums">
                            {mask(formatCurrency(acc.balance_primary, userCurrency, locale))}
                          </p>
                        )}
                      </div>
                      {canWrite && (
                        <AccountRowActions
                          accountName={getAccountName(acc)}
                          onEdit={() => { setEditingAccount(acc); setDialogOpen(true) }}
                          onClose={() => setClosingAccountId(acc.id)}
                          onDelete={acc.connection_id === null ? () => setDeletingId(acc.id) : undefined}
                          deletePending={deleteMutation.isPending}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="px-5 py-8 text-center">
                <p className="text-sm text-muted-foreground">
                  {t(activeAccountIds ? 'accounts.emptyFiltered' : 'accounts.noAccountsFound')}
                </p>
              </div>
            )}
          </div>

          {/* Closed Accounts */}
          {closedAccounts.length > 0 && (
            <div className="bg-card rounded-xl border border-border shadow-sm opacity-60">
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
                <h2 className="text-sm font-medium text-muted-foreground">{t('accounts.closedAccounts')}</h2>
              </div>
              <div className="divide-y divide-muted">
                {closedAccounts.map((acc) => {
                  return (
                    <div key={acc.id} className="flex items-center px-5 py-3">
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <AccountIcon account={acc} />
                        <p className="text-sm font-medium text-muted-foreground truncate">{getAccountLabel(acc)}</p>
                      </div>
                      {canWrite && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs text-muted-foreground hover:text-foreground h-7 px-2 mr-3"
                          onClick={() => reopenMutation.mutate(acc.id)}
                          disabled={reopenMutation.isPending}
                        >
                          {t('accounts.reopen')}
                        </Button>
                      )}
                      <p className="text-sm font-semibold tabular-nums text-muted-foreground w-32 text-right">
                        {mask(formatCurrency(Number(acc.current_balance), acc.currency, locale))}
                      </p>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Confirm delete dialog */}
      <Dialog open={!!deletingId} onOpenChange={() => setDeletingId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('accounts.confirmDeleteTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t('accounts.confirmDeleteDesc')}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingId(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => deletingId && deleteMutation.mutate(deletingId)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? t('common.loading') : t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm close dialog */}
      <Dialog open={!!closingAccountId} onOpenChange={() => setClosingAccountId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('accounts.close')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t('accounts.confirmClose')}
          </p>
          {accountsList?.find(a => a.id === closingAccountId)?.connection_id && (
            <p className="text-sm text-amber-600 font-medium">
              {t('accounts.confirmCloseBank')}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setClosingAccountId(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="default"
              onClick={() => closingAccountId && closeMutation.mutate(closingAccountId)}
              disabled={closeMutation.isPending}
            >
              {closeMutation.isPending ? t('common.loading') : t('accounts.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Account Dialog */}
      <AccountDialog
        open={dialogOpen}
        onClose={() => { setDialogOpen(false); setEditingAccount(null) }}
        account={editingAccount}
        onSave={(data) => {
          if (editingAccount) {
            updateMutation.mutate({ id: editingAccount.id, ...data })
          } else {
            createMutation.mutate(data as { name: string; type: string; balance?: number; balance_date?: string; currency?: string })
          }
        }}
        loading={createMutation.isPending || updateMutation.isPending}
      />
    </div>
  )
}

// The contract terms of a loan as the dialog edits them (inputs hold strings).
type LoanTermsForm = {
  kind: string
  amount: string
  rate: string
  period: LoanRatePeriod
  term: string
  firstPayment: string
  amortization: LoanAmortization
}

const LOAN_KINDS = ['mortgage', 'auto', 'personal', 'student', 'other'] as const

function loanTermsFrom(account: Account | null | undefined, currency: string): LoanTermsForm {
  return {
    kind: account?.loan_kind ?? '',
    amount: account?.loan_original_amount?.toString() ?? '',
    rate: account?.loan_interest_rate?.toString() ?? '',
    // Brazilian loans are usually quoted per month; elsewhere a yearly APR.
    period: account?.loan_rate_period ?? (currency === 'BRL' ? 'monthly' : 'yearly_nominal'),
    term: account?.loan_term_months?.toString() ?? '',
    firstPayment: account?.loan_first_payment_date ?? '',
    amortization: account?.loan_amortization ?? 'price',
  }
}

type LoanTermsPayload = Pick<
  Account,
  | 'loan_kind'
  | 'loan_original_amount'
  | 'loan_interest_rate'
  | 'loan_rate_period'
  | 'loan_term_months'
  | 'loan_first_payment_date'
  | 'loan_amortization'
>

function loanTermsPayload(terms: LoanTermsForm): LoanTermsPayload {
  const number = (value: string) => (value.trim() === '' ? null : Number(value))
  return {
    loan_kind: (terms.kind || null) as Account['loan_kind'],
    loan_original_amount: number(terms.amount),
    loan_interest_rate: number(terms.rate),
    loan_rate_period: terms.period,
    loan_term_months: number(terms.term),
    loan_first_payment_date: terms.firstPayment || null,
    loan_amortization: terms.amortization,
  }
}

export function AccountDialog({
  open,
  onClose,
  account,
  onSave,
  defaultType = 'checking',
  loading,
}: {
  open: boolean
  onClose: () => void
  account: Account | null
  onSave: (data: {
    name?: string
    display_name?: string | null
    type?: string
    balance?: number
    balance_date?: string
    currency?: string
    secured_asset_id?: string | null
    credit_limit?: number | null
    statement_close_day?: number | null
    payment_due_day?: number | null
  }) => void
  loading: boolean
  defaultType?: string
}) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const userCurrency = user?.preferences?.currency_display ?? 'USD'
  const { data: supportedCurrencies } = useQuery({
    queryKey: ['currencies'],
    queryFn: currencies.list,
    staleTime: Infinity,
  })
  const { data: assetsList } = useQuery({
    queryKey: ['assets'],
    queryFn: () => assets.list(),
    enabled: open,
  })
  const [name, setName] = useState(account?.name ?? '')
  const [displayName, setDisplayName] = useState(account?.display_name ?? '')
  const [type, setType] = useState(account?.type ?? defaultType)
  const [balance, setBalance] = useState(account?.balance?.toString() ?? '0')
  const [currency, setCurrency] = useState(account?.currency ?? userCurrency)
  // The opening balance's own date (issue #1204); today for a new account
  // or one without an opening balance.
  const initialBalanceDate = () => account?.balance_date ?? localDateString()
  const [balanceDate, setBalanceDate] = useState(initialBalanceDate)
  const [creditLimit, setCreditLimit] = useState(account?.credit_limit?.toString() ?? '')
  const [statementCloseDay, setStatementCloseDay] = useState(account?.statement_close_day?.toString() ?? '')
  const [paymentDueDay, setPaymentDueDay] = useState(account?.payment_due_day?.toString() ?? '')
  const [securedAssetId, setSecuredAssetId] = useState(account?.secured_asset_id ?? '')
  const [loanTerms, setLoanTerms] = useState(() => loanTermsFrom(account, account?.currency ?? userCurrency))
  // Opened by the user, not by the amount: clearing the amount must not collapse it.
  const [termsOpen, setTermsOpen] = useState(() => account?.loan_original_amount != null)
  const setLoanTerm = <K extends keyof LoanTermsForm>(key: K, value: LoanTermsForm[K]) =>
    setLoanTerms((prev) => ({ ...prev, [key]: value }))

  const properties = (assetsList ?? []).filter((asset) => LOAN_COLLATERAL_TYPES.includes(asset.type))
  // Send the link the select shows: a saved id that is no longer a listed
  // property (it changed type) would otherwise be resent and rejected.
  const securedAssetIsListed = !!securedAssetId && (!assetsList || properties.some((asset) => asset.id === securedAssetId))
  const [formSource, setFormSource] = useState<{
    account: typeof account
    balanceDate: string
  } | null>(null)
  if (!formSource || formSource.account !== account) {
    const date = initialBalanceDate()
    setFormSource({ account, balanceDate: date })
    setName(account?.name ?? '')
    setDisplayName(account?.display_name ?? '')
    setType(account?.type ?? defaultType)
    setBalance(account?.balance?.toString() ?? '0')
    setCurrency(account?.currency ?? userCurrency)
    setBalanceDate(date)
    setCreditLimit(account?.credit_limit?.toString() ?? '')
    setStatementCloseDay(account?.statement_close_day?.toString() ?? '')
    setPaymentDueDay(account?.payment_due_day?.toString() ?? '')
    setSecuredAssetId(account?.secured_asset_id ?? '')
    setLoanTerms(loanTermsFrom(account, account?.currency ?? userCurrency))
    setTermsOpen(account?.loan_original_amount != null)
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {account ? t('accounts.editAccount') : t('accounts.addManual')}
          </DialogTitle>
        </DialogHeader>
        <form
          key={account?.id ?? 'new'}
          onSubmit={(e) => {
            e.preventDefault()
            const isCC = type === 'credit_card'
            const parseDay = (v: string) => {
              const n = parseInt(v, 10)
              return Number.isFinite(n) && n >= 1 && n <= 31 ? n : null
            }
            const isConnected = !!account?.connection_id
            // Editing: only move the opening balance when the date was changed.
            const dateChanged = !account || balanceDate !== formSource?.balanceDate
            onSave({
              ...(!isConnected && {
                name,
                balance: parseFloat(balance),
                ...(dateChanged && { balance_date: balanceDate }),
                currency,
              }),
              type,
              ...(type === 'loan' && {
                secured_asset_id: securedAssetIsListed ? securedAssetId : null,
                ...loanTermsPayload(loanTerms),
              }),
              display_name: displayName.trim() || null,
              ...(isCC && {
                credit_limit: creditLimit !== '' ? parseFloat(creditLimit) : null,
                statement_close_day: parseDay(statementCloseDay),
                payment_due_day: parseDay(paymentDueDay),
              }),
            })
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label>{t('accounts.accountName')}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required disabled={!!account?.connection_id} />
          </div>
          {account?.connection_id && (
            <div className="space-y-2">
              <Label>{t('accounts.displayName')}</Label>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={name}
              />
              <p className="text-xs text-muted-foreground">{t('accounts.displayNameHint')}</p>
            </div>
          )}
          {account?.connection_id && (
            <div className="space-y-2">
              <Label>{t('accounts.accountType')}</Label>
              <select
                className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                value={type}
                onChange={(e) => setType(e.target.value)}
              >
                {ACCOUNT_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{t('accounts.typeOverrideHint')}</p>
            </div>
          )}
          {!account?.connection_id && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{t('accounts.accountType')}</Label>
                  <select
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                  >
                    {ACCOUNT_TYPE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
                    ))}
                  </select>
                  {account && type !== account.type && (type === 'loan' || account.type === 'loan') && (
                    <p className="text-xs text-muted-foreground">{t('accounts.loanRetypeHint')}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label>{t('accounts.currency')}</Label>
                  <select
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                  >
                    {(supportedCurrencies ?? [{ code: userCurrency, symbol: userCurrency, name: userCurrency, flag: '' }]).map((c) => (
                      <option key={c.code} value={c.code}>{c.flag} {c.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>
                    {type === 'credit_card'
                      ? t('accounts.balanceCreditCard')
                      : type === 'loan'
                        ? t('accounts.balanceLoan')
                        : t('accounts.balance')}
                  </Label>
                  <Input
                    type="number"
                    step="0.01"
                    min={type === 'credit_card' || type === 'loan' ? '0' : undefined}
                    value={balance}
                    onChange={(e) => setBalance(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t('accounts.balanceDate')}</Label>
                  <DatePickerInput
                    value={balanceDate}
                    onChange={setBalanceDate}
                    className="w-full justify-start"
                  />
                </div>
              </div>
              {type === 'credit_card' && (
                <p className="text-xs text-muted-foreground -mt-2">
                  {t('accounts.balanceCreditCardHint')}
                </p>
              )}
            </>
          )}
          {type === 'loan' && (
            <div className="space-y-2">
              <Label>{t('accounts.securedProperty')}</Label>
              <select
                className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                value={securedAssetId}
                onChange={(e) => setSecuredAssetId(e.target.value)}
              >
                <option value="">{t('accounts.noSecuredProperty')}</option>
                {properties.map((asset) => (
                  <option key={asset.id} value={asset.id}>{asset.name}</option>
                ))}
              </select>
              <details
                className="rounded-lg border border-border p-3 mt-2"
                open={termsOpen}
                onToggle={(e) => setTermsOpen(e.currentTarget.open)}
              >
                <summary className="cursor-pointer text-sm font-medium">{t('accounts.loanTerms')}</summary>
                <div className="grid grid-cols-2 gap-3 pt-3">
                  <div className="space-y-1">
                    <Label>{t('accounts.loanKind')}</Label>
                    <select className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary" value={loanTerms.kind} onChange={(e) => setLoanTerm('kind', e.target.value)}>
                      <option value="">{t('accounts.loanKindNone')}</option>
                      {LOAN_KINDS.map((kind) => (
                        <option key={kind} value={kind}>{t(`accounts.loanKinds.${kind}`)}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label>{t('accounts.loanOriginalAmount')}</Label>
                    <Input type="number" step="0.01" min="0.01" value={loanTerms.amount} onChange={(e) => setLoanTerm('amount', e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label>{t('accounts.loanInterestRate')}</Label>
                    <Input type="number" step="0.0001" min="0" max="100" value={loanTerms.rate} onChange={(e) => setLoanTerm('rate', e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label>{t('accounts.loanRatePeriod')}</Label>
                    <select className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary" value={loanTerms.period} onChange={(e) => setLoanTerm('period', e.target.value as LoanRatePeriod)}>
                      <option value="monthly">{t('accounts.loanRatePeriods.monthly')}</option>
                      <option value="yearly_effective">{t('accounts.loanRatePeriods.yearly_effective')}</option>
                      <option value="yearly_nominal">{t('accounts.loanRatePeriods.yearly_nominal')}</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label>{t('accounts.loanTermMonths')}</Label>
                    <Input type="number" step="1" min="1" max="600" value={loanTerms.term} onChange={(e) => setLoanTerm('term', e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label>{t('accounts.loanFirstPayment')}</Label>
                    <DatePickerInput value={loanTerms.firstPayment} onChange={(value) => setLoanTerm('firstPayment', value)} className="w-full justify-start" />
                  </div>
                  <div className="space-y-1 col-span-2">
                    <Label>{t('accounts.loanAmortization')}</Label>
                    <select className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary" value={loanTerms.amortization} onChange={(e) => setLoanTerm('amortization', e.target.value as LoanAmortization)}>
                      <option value="price">{t('accounts.loanAmortizations.price')}</option>
                      <option value="sac">{t('accounts.loanAmortizations.sac')}</option>
                    </select>
                  </div>
                </div>
              </details>
            </div>
          )}
          {type === 'credit_card' && (
            <div className="space-y-4 rounded-lg border border-border bg-muted/30 p-4">
              <div className="space-y-2">
                <Label>{t('accounts.creditLimit')}</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={creditLimit}
                  onChange={(e) => setCreditLimit(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{t('accounts.statementCloseDay')}</Label>
                  <Input
                    type="number"
                    min="1"
                    max="31"
                    value={statementCloseDay}
                    onChange={(e) => setStatementCloseDay(e.target.value)}
                    placeholder={t('accounts.dayOfMonthHint')}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t('accounts.paymentDueDay')}</Label>
                  <Input
                    type="number"
                    min="1"
                    max="31"
                    value={paymentDueDay}
                    onChange={(e) => setPaymentDueDay(e.target.value)}
                    placeholder={t('accounts.dayOfMonthHint')}
                  />
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? t('common.loading') : t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
