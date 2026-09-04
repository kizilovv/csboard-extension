/*
  Typed against the English dictionary: a key added there and forgotten here is
  a `tsc` error, not a raw key id rendered in the popup.
*/

import type { en, MessageKey } from './en';

export const ru: Record<MessageKey, string> = {
  // Шапка
  'lang.label': 'Язык',
  'lang.auto': 'Авто',
  'status.checking': 'Проверяем…',
  'status.connected': 'На связи',
  'status.signedOut': 'Не вошли',
  'status.offline': 'Нет связи',

  // Аккаунт
  'account.signIn': 'Войти',
  'account.open': 'Открыть csboard',
  'account.premium': 'Премиум',
  'account.signedOut': 'Вход не выполнен',
  'account.offline': 'csboard недоступен',

  // Сайты и уведомления
  'sites.eyebrow': 'Показывать csboard на',
  'sites.steam': 'Steam',
  'sites.csfloat': 'CSFloat',
  'sites.buff': 'Buff163',
  'notifications.sales': 'Уведомлять о продажах',

  // Цены
  'prices.title': 'Цены',
  'prices.pull': 'Синхр.',
  'prices.currency': 'Валюта',
  'prices.source': 'Источник',
  'prices.follow': 'Брать настройки из csboard',
  'prices.refresh': 'Обновить',
  'prices.refreshing': 'Обновляем…',
  'prices.cache': '{count} цен',
  'prices.cacheEmpty': 'Цены не загружены',
  'prices.cacheUnknown': 'Кэш недоступен',
  'prices.updated': 'обновлено {ago}',
  'prices.updatedNever': 'ни разу не загружали',
  'sync.off': 'Выкл — остаются локальные значения',
  'sync.syncing': 'Синхронизируем…',
  'sync.following': 'Следуем за csboard',
  'sync.followingAgo': 'Следуем за csboard · {ago}',
  'sync.warning': 'Синхронизировано с замечанием: {code}',
  'sync.error': 'Синхронизация не прошла — оставили прежние значения',
  'sync.signedOut': 'Войдите в csboard, чтобы синхронизировать',
  'sync.unavailable': 'Недоступно в этой сборке',

  // Портфель CSFolder
  'portfolio.eyebrow': 'CSFolder',
  'portfolio.title': 'Синхронизация портфеля',
  'portfolio.badge.checking': 'Проверка',
  'portfolio.badge.unavailable': 'Недоступно',
  'portfolio.badge.unpaired': 'Не привязан',
  'portfolio.badge.paired': 'Привязан',
  'portfolio.badge.enabled': 'Включено',
  'portfolio.badge.revoked': 'Отозван',
  'portfolio.badge.mismatch': 'Не тот аккаунт',
  'portfolio.badge.error': 'Ошибка',
  'portfolio.state.checking': 'Проверяем привязку…',
  'portfolio.state.unavailable': 'Недоступно в этой сборке. Ничего не отправляется.',
  'portfolio.state.unpaired': 'Не привязан. Установка сама по себе ничего не отправляет.',
  'portfolio.state.pairedOff': 'Привязан. Отправка выключена.',
  'portfolio.state.pairedOn': 'Включённые источники синхронизируются примерно раз в час.',
  'portfolio.state.paused': 'Приостановлено сервером. Повторите вручную.',
  'portfolio.state.revoked': 'Устройство отозвано. Отвяжите и привяжите заново.',
  'portfolio.state.mismatch': 'Активный аккаунт Steam не совпадает с привязанным. Синхронизация заблокирована.',
  'portfolio.state.error': 'Ошибка подключения: {code}',
  'portfolio.pairLink': 'Привязать в портфеле CSFolder',
  'portfolio.steamId': 'Steam ID {id}',
  'portfolio.enable': 'Отправлять портфель',
  'portfolio.sources.legend': 'Источники данных портфеля',
  'portfolio.sources.inventory': 'Инвентарь',
  'portfolio.sources.tradeHistory': 'История обменов',
  'portfolio.src.off': 'Выкл',
  'portfolio.src.ready': 'Готово',
  'portfolio.src.queued': 'В очереди',
  'portfolio.src.running': 'Синхронизация',
  'portfolio.src.synced': 'Синхронизировано',
  'portfolio.src.error': 'Ошибка',
  'portfolio.src.on': 'Вкл',
  'portfolio.src.unavailable': 'Недоступно',
  'portfolio.metric.lastOk': 'Успех',
  'portfolio.metric.lastTry': 'Попытка',
  'portfolio.metric.queued': 'В очереди',
  'portfolio.syncNow': 'Синхронизировать',
  'portfolio.syncing': 'Синхронизируем…',
  'portfolio.unpair': 'Отвязать',
  'portfolio.unpairConfirm': 'Отвязать этот браузер от CSFolder? Данные из очереди не уйдут.',
  'portfolio.disclosure.summary': 'Что отправляется',
  'portfolio.disclosure.body': 'Когда вы включаете отправку, уходят данные инвентаря и до 100 последних обменов Steam из выбранных источников, а для принятых обменов за последние 30 дней — идентификатор завершённого обмена и необязательная подсказка Buff163 или CSFloat. Никогда не уходят: активные предложения, сырые заметки Steam, история Steam Market, учётные данные Steam. Автосинхронизация — примерно раз в час.',

  // Сообщения
  'notice.saveFailed': 'Не сохранили. Вернули прежнее значение.',
  'notice.reloadTab': 'Сохранено. Перезагрузите вкладку.',
  'notice.notifyOn': 'Сообщим, когда продажа потребует вас.',
  'notice.notifyOff': 'Уведомления выключены. Счётчик на иконке остаётся.',
  'notice.prefsSynced': 'Настройки цен из csboard применены.',
  'notice.pricesLoaded': 'Загружено {count} строк цен.',
  'notice.pricesFailed': 'Обновление не прошло. Кэш цен сохранён.',
  'notice.uploadsOn': 'Отправка портфеля включена.',
  'notice.uploadsOff': 'Отправка портфеля приостановлена.',
  'notice.unpaired': 'Устройство отвязано, отправка выключена.',
  'notice.unpairFailed': 'Не удалось отвязать. Локально ничего не удалено.',
  'notice.syncDone': 'Синхронизация портфеля завершена.',
  'notice.syncPartial': 'Часть источников Steam была недоступна. Остальное ушло.',
  'notice.syncTruncated': 'История обменов синхронизирована частично — только свежие записи.',
  'notice.syncOversized': 'Готово, но слишком большие записи пропущены.',
  'notice.syncWarning': 'Готово с замечанием источника. Посмотрите статус источника.',
  'notice.syncFailed': 'Синхронизация не завершилась{cause}. Записи из очереди повторятся.',

  // Относительное время
  'time.never': 'Никогда',
  'time.now': 'только что',
  'time.seconds': '{n} с назад',
  'time.minutes': '{n} мин назад',
  'time.hours': '{n} ч назад',
  'time.days': '{n} дн назад',

  // Коды состояния из фонового процесса
  'code.STEAM_SESSION_REQUIRED': 'войдите в Steam или откройте вкладку Steam с активной сессией',
  'code.STEAM_ACCOUNT_MISMATCH': 'активный аккаунт Steam не совпадает с привязанным',
  'code.STEAM_RATE_LIMITED': 'Steam ограничил частоту запросов, повторите позже',
  'code.STEAM_UNAVAILABLE': 'Steam временно недоступен',
  'code.STEAM_RESPONSE_INVALID': 'Steam вернул неподдерживаемый ответ',
  'code.STEAM_READ_FAILED': 'не удалось прочитать данные Steam',
  'code.TRADE_HISTORY_TRUNCATED': 'частично, только свежие записи',
  'code.OVERSIZED_RECORDS_DROPPED': 'слишком большие записи пропущены',
};

// Referenced so the English dictionary stays a compile-time dependency of this
// file: rename a key there and this import, not a user, reports it.
export type RussianDictionaryShape = Record<keyof typeof en, string>;
