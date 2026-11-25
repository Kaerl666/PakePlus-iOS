// 车牌记录管理系统
class BusRecordsManager {
    constructor() {
        this.storageKey = 'busRecords';
        // in-memory records (synchronous access for existing code)
        // Forcibly disable reading from localStorage and purge existing localStorage data
        this.records = [];
        this._skipMigration = true; // do not migrate from localStorage
        try {
            this.purgeLocalStorageRecords();
            console.log('强制清除 localStorage 中的车牌数据（按请求）');
        } catch (e) {
            console.warn('强制清除 localStorage 失败：', e);
        }
        this._migrated = true;
        // IndexedDB settings
        this._dbName = 'BusRecordsDB';
        this._storeName = 'records';
        this._dbPromise = this._openDB();
        // after DB opens, migrate or sync if needed
        this._dbPromise.then(db => this._postInit(db)).catch(err => {
            console.warn('IndexedDB 初始化失败，继续使用 localStorage：', err);
        });
        // whether we've migrated to using DB as primary store
        // already set above when purging
    }

    // 从本地存储加载记录
    loadRecords() {
        // 已取消自动从 localStorage 迁移/回退，优先使用内存中的 records（同步返回）
        try {
            return Array.isArray(this.records) ? this.records : [];
        } catch (error) {
            console.error('读取内存中车牌记录失败:', error);
            return [];
        }
    }

    // 保存记录到本地存储，可选只写入新增记录
    saveRecords(newRecords = null) {
        // Persist records to IndexedDB asynchronously. Return a Promise so callers can await completion.
        if (this._dbPromise) {
            return this._dbPromise
                .then(() => this._writeAllToDB(this.records, newRecords))
                .catch(err => {
                    // If DB write fails, log error and rethrow so callers can handle/ retry.
                    console.error('保存车牌记录到 IndexedDB 失败（已停止写入 localStorage）:', err);
                    throw err;
                });
        } else {
            // If IndexedDB not available, still do not write to localStorage per new policy.
            console.error('IndexedDB 不可用，且已配置停止写入 localStorage，记录未持久化');
            return Promise.reject(new Error('IndexedDB 不可用'));
        }
    }

    /* IndexedDB helpers */
    _openDB() {
        return new Promise((resolve, reject) => {
            if (!window.indexedDB) {
                return reject(new Error('浏览器不支持 IndexedDB'));
            }
            const req = indexedDB.open(this._dbName, 1);
            req.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this._storeName)) {
                    const store = db.createObjectStore(this._storeName, { keyPath: 'id' });
                    store.createIndex('busId', 'busId', { unique: false });
                    store.createIndex('lineName', 'lineName', { unique: false });
                    store.createIndex('date', 'date', { unique: false });
                }
            };
            req.onsuccess = (event) => {
                resolve(event.target.result);
            };
            req.onerror = (event) => {
                reject(event.target.error || new Error('IndexedDB 打开失败'));
            };
        });
    }

    async _postInit(db) {
        try {
            // If skipMigration is set, do not attempt to read or migrate from localStorage.
            if (this._skipMigration) {
                const existing = await this._getAllFromDB();
                if (existing && existing.length > 0) {
                    this.records = existing;
                    this.mergeDuplicateTouristRecords().then(count => {
                        if (count > 0) console.log(`已合并 ${count} 条重复旅游直通车记录`);
                    });
                }
                return;
            }
            // Check whether DB has records; if empty but localStorage has data, migrate
            const existing2 = await this._getAllFromDB();
            if ((!existing2 || existing2.length === 0) && localStorage.getItem(this.storageKey)) {
                try {
                    const data = JSON.parse(localStorage.getItem(this.storageKey) || '[]');
                    if (Array.isArray(data) && data.length > 0) {
                        await this._writeAllToDB(data);
                        // mark migrated and remove old localStorage data to free space
                        try { localStorage.setItem(this.storageKey + '_migrated', '1'); } catch (e) {}
                        this._migrated = true;
                        try {
                            this.purgeLocalStorageRecords();
                            console.log('已从 localStorage 迁移到 IndexedDB，并删除旧 localStorage 数据');
                        } catch (e) {
                            console.warn('迁移后删除 localStorage 失败：', e);
                        }
                    }
                } catch (e) {
                    console.warn('从 localStorage 迁移到 IndexedDB 时解析失败：', e);
                }
            } else if (existing2 && existing2.length > 0) {
                // prefer DB content if it's present and differs from memory
                // Replace in-memory records with DB records to keep single source of truth
                this.records = existing2;
                // DB 有内容：将其作为单一数据源，替换内存并标记已迁移。
                this._migrated = true;
                this.mergeDuplicateTouristRecords().then(count => {
                    if (count > 0) console.log(`已合并 ${count} 条重复旅游直通车记录`);
                });
                try {
                    this.purgeLocalStorageRecords();
                    console.log('IndexedDB 有内容，已切换为 DB 主存储并删除旧 localStorage 数据');
                } catch (e) {
                    console.warn('切换为 DB 后删除 localStorage 失败：', e);
                }
            }
        } catch (err) {
            console.warn('IndexedDB _postInit 处理失败：', err);
        }
    }

    _getAllFromDB() {
        return new Promise((resolve, reject) => {
            this._openDB().then(db => {
                const tx = db.transaction(this._storeName, 'readonly');
                const store = tx.objectStore(this._storeName);
                const req = store.getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error || new Error('getAll 失败'));
            }).catch(reject);
        });
    }

    // 批量从 IndexedDB 删除指定 id 列表，返回 Promise 在事务完成时 resolve
    _deleteRecordsByIds(ids) {
        return new Promise((resolve, reject) => {
            if (!Array.isArray(ids) || ids.length === 0) return resolve(true);
            this._openDB().then(db => {
                try {
                    const tx = db.transaction(this._storeName, 'readwrite');
                    const store = tx.objectStore(this._storeName);
                    for (const id of ids) {
                        try {
                            store.delete(id);
                        } catch (e) {
                            console.error('store.delete 单条异常:', e);
                        }
                    }
                    tx.oncomplete = () => resolve(true);
                    tx.onerror = () => reject(tx.error || new Error('transaction 批量删除失败'));
                } catch (e) {
                    reject(e);
                }
            }).catch(reject);
        });
    }

    // 清空 IndexedDB 中的所有记录（不改变内存），返回 Promise
    _clearAllInDB() {
        return new Promise((resolve, reject) => {
            this._openDB().then(db => {
                try {
                    const tx = db.transaction(this._storeName, 'readwrite');
                    const store = tx.objectStore(this._storeName);
                    const clearReq = store.clear();
                    clearReq.onsuccess = () => {
                        // wait for tx.oncomplete
                    };
                    clearReq.onerror = () => {
                        // still let tx handlers decide
                    };
                    tx.oncomplete = () => resolve(true);
                    tx.onerror = () => reject(tx.error || new Error('transaction clear 失败'));
                } catch (e) {
                    reject(e);
                }
            }).catch(reject);
        });
    }

    // 将单条记录写入 IndexedDB，返回 Promise 在写入完成时 resolve
    _putRecordToDB(record) {
        return new Promise((resolve, reject) => {
            this._openDB().then(db => {
                try {
                    const tx = db.transaction(this._storeName, 'readwrite');
                    const store = tx.objectStore(this._storeName);
                    const req = store.put(record);
                    req.onsuccess = () => {
                        // 等待事务完成以确保数据持久化
                    };
                    req.onerror = (ev) => {
                        console.error('单条写入失败:', ev?.target?.error || ev);
                    };
                    tx.oncomplete = () => resolve(true);
                    tx.onerror = () => reject(tx.error || new Error('transaction 写入失败'));
                } catch (e) {
                    reject(e);
                }
            }).catch(reject);
        });
    }

    // 保存单条记录并返回 Promise，供调用方 await
    saveRecord(record) {
        if (!record) return Promise.reject(new Error('record 为空'));
        if (this._dbPromise) {
            return this._dbPromise.then(() => this._putRecordToDB(record));
        } else {
            return Promise.reject(new Error('IndexedDB 不可用'));
        }
    }

    // 写入记录到 IndexedDB，可选只写入新记录（不清空已有数据）
    _writeAllToDB(records, newRecords = null) {
        return new Promise((resolve, reject) => {
            this._openDB().then(db => {
                const tx = db.transaction(this._storeName, 'readwrite');
                const store = tx.objectStore(this._storeName);
                let hadError = false;
                let pending = 0;
                const onPutError = (err) => {
                    hadError = true;
                    console.error('写入记录到 IndexedDB 时单条失败：', err);
                };

                const finalize = () => {
                    // tx.oncomplete / onerror will handle final resolve/reject
                };

                // 批量写入：只写入 newRecords（不清空已有数据）
                if (newRecords !== null) {
                    const toWrite = newRecords.length > 0 ? newRecords : records;
                    for (const r of toWrite) {
                        pending++;
                        const putReq = store.put(r);
                        putReq.onsuccess = () => {
                            pending--;
                            if (pending === 0) finalize();
                        };
                        putReq.onerror = (ev) => {
                            pending--;
                            onPutError(ev?.target?.error || ev);
                            if (pending === 0) finalize();
                        };
                    }
                    if (toWrite.length === 0) finalize();
                } else {
                    // 全量写入：先清空再写入（兼容原有行为）
                    const clearReq = store.clear();
                    clearReq.onsuccess = () => {
                        try {
                            for (const r of records) {
                                pending++;
                                const putReq = store.put(r);
                                putReq.onsuccess = () => {
                                    pending--;
                                    if (pending === 0) finalize();
                                };
                                putReq.onerror = (ev) => {
                                    pending--;
                                    onPutError(ev?.target?.error || ev);
                                    if (pending === 0) finalize();
                                };
                            }
                            if (records.length === 0) finalize();
                        } catch (e) {
                            onPutError(e);
                        }
                    };
                    clearReq.onerror = () => {
                        // 如果 clear 失败，也继续尝试写入
                        try {
                            for (const r of records) {
                                pending++;
                                const putReq = store.put(r);
                                putReq.onsuccess = () => {
                                    pending--;
                                    if (pending === 0) finalize();
                                };
                                putReq.onerror = (ev) => {
                                    pending--;
                                    onPutError(ev?.target?.error || ev);
                                    if (pending === 0) finalize();
                                };
                            }
                            if (records.length === 0) finalize();
                        } catch (e) {
                            onPutError(e);
                        }
                    };
                }

                tx.oncomplete = () => {
                    if (hadError) {
                        reject(new Error('部分记录写入失败，请检查控制台日志'));
                    } else {
                        resolve(true);
                    }
                };
                tx.onerror = () => {
                    reject(tx.error || new Error('transaction 写入失败'));
                };
            }).catch(reject);
        });
    }

    // 导出所有记录为 JSON 字符串（与旧 localStorage 格式兼容）
    exportRecordsJSON() {
        return this._getAllFromDB().then(records => JSON.stringify(records));
    }

    // 从 JSON 导入记录（会覆盖现有 DB 内容并更新内存）
    importRecordsFromJSON(json) {
        try {
            const data = JSON.parse(json || '[]');
            if (!Array.isArray(data)) return Promise.reject(new Error('导入数据格式错误'));
            // sanitize / validate items minimally
            const normalized = data.map(item => {
                // keep existing fields if present; ensure id exists
                return Object.assign({
                    id: item.id || (Date.now() + Math.floor(Math.random() * 10000)),
                    busId: String(item.busId || '').trim(),
                    lineName: String(item.lineName || '').trim(),
                    date: item.date || '',
                    recordTime: item.recordTime || '',
                    timestamp: item.timestamp || new Date().toISOString(),
                    isManual: !!item.isManual
                }, item);
            });
            // write to DB and update memory
            return this._writeAllToDB(normalized).then(() => {
                this.records = normalized;
                // mark migrated and purge old localStorage backup to free space
                this._migrated = true;
                try { localStorage.setItem(this.storageKey + '_migrated', '1'); } catch (e) {}
                try {
                    this.purgeLocalStorageRecords();
                } catch (e) {
                    console.warn('导入后删除 localStorage 失败：', e);
                }
                return true;
            });
        } catch (e) {
            return Promise.reject(e);
        }
    }

    // 清除旧的 localStorage 存储（在确认服务器同步并回写后调用）
    purgeLocalStorageRecords() {
        try {
            localStorage.removeItem(this.storageKey);
            localStorage.removeItem(this.storageKey + '_migrated');
            return true;
        } catch (e) {
            console.warn('清除 localStorage 失败:', e);
            return false;
        }
    }

    // 添加车牌记录（现在会在写入本地后再返回，确保持久化）
    async addRecord(busId, lineId, lineName, date = null, isManual = false) {
        if (!busId) return;

        // 标准化线路名称，确保一致性
        lineName = this.normalizeLineName(lineName);

        const now = new Date();
        // 获取本地时间的日期字符串，避免时区问题
        const getLocalDateString = (dateObj) => {
            const year = dateObj.getFullYear();
            const month = String(dateObj.getMonth() + 1).padStart(2, '0');
            const day = String(dateObj.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        };
        
        const record = {
            id: Date.now() + Math.floor(Math.random() * 10000),
            busId: String(busId).trim(),
            lineName: String(lineName).trim(),
            date: date || getLocalDateString(now),
            recordTime: isManual ? '手动添加' : now.toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            }),
            timestamp: now.toISOString(),
            isManual: isManual
        };

        // 检查是否已存在相同记录
        const exists = this.records.some(r => 
            r.busId === record.busId && 
            r.lineName === record.lineName && 
            r.date === record.date
        );

        if (!exists) {
            this.records.push(record);

            // 如果添加的是真实线路记录（不是"占位线"），则删除该车牌的所有"占位线"记录
            if (record.lineName !== '占位线') {
                this.removeTemporaryRecords(record.busId);
            }

            // 立即把这条记录写入 IndexedDB，等待完成再返回
            try {
                await this.saveRecord(record);
            } catch (err) {
                console.error('写入单条记录失败:', err);
                // 写入失败时仍然保留内存记录，但向上抛出或返回 false 以便调用方处理
                throw err;
            }

            return true;
        }

        return false;
    }

    // 删除指定车牌的占位线记录
    removeTemporaryRecords(busId) {
        const originalLength = this.records.length;
        this.records = this.records.filter(record => 
            !(record.busId === busId && record.lineName === '占位线')
        );
        
        if (this.records.length < originalLength) {
            console.log(`已删除车牌 ${busId} 的占位线记录`);
        }
    }

    // 批量添加记录
    async addBatchRecords(busLicenses, lineId, lineName) {
        if (!Array.isArray(busLicenses)) return;

        // 确保车牌代号纠正功能已初始化
        if (!this._busIdCorrectionMap) {
            this.initBusIdCorrectionMap();
        }

        // 获取本地时间的今日日期
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        let addedCount = 0;

        for (const bus of busLicenses) {
            if (bus.busId) {
                // 纠正车牌代号为核心车牌
                const correctedBusId = this.correctBusId(bus.busId);

                // 先标准化线路名称，确保与 addRecord 方法的处理一致
                const normalizedLineName = this.normalizeLineName(lineName);
                const exists = this.records.some(r =>
                    r.busId === correctedBusId &&
                    r.lineName === normalizedLineName &&
                    r.date === today
                );

                if (!exists) {
                    const wasAdded = await this.addRecord(correctedBusId, null, lineName, today, false);
                    if (wasAdded) {
                        addedCount++;
                    }
                }
            }
        }

        if (addedCount > 0) {
            console.log(`批量添加 ${addedCount} 条车牌记录`);
        }

        return addedCount;
    }

    // 搜索记录
    searchRecords(searchTerm, searchType = 'all', targetDate = null) {
        if (!searchTerm && !targetDate) return this.records;

        return this.records.filter(record => {
            let matches = true;

            if (targetDate) {
                matches = matches && record.date === targetDate;
            }

            if (searchTerm) {
                const term = String(searchTerm).toLowerCase().trim();
                switch (searchType) {
                    case 'busId':
                        matches = matches && String(record.busId).toLowerCase().includes(term);
                        break;
                    case 'lineName':
                        matches = matches && String(record.lineName).toLowerCase().includes(term);
                        break;
                    case 'vehicleType':
                        // 获取车牌对应的车型信息
                        const vehicleType = this.getVehicleType(record.busId);
                        matches = matches && vehicleType && vehicleType.toLowerCase().includes(term);
                        break;
                    case 'all':
                    default:
                        // 获取车牌对应的车型信息
                        const allVehicleType = this.getVehicleType(record.busId);
                        matches = matches && (
                            String(record.busId).toLowerCase().includes(term) ||
                            String(record.lineName).toLowerCase().includes(term) ||
                            (allVehicleType && allVehicleType.toLowerCase().includes(term))
                        );
                        break;
                }
            }

            return matches;
        });
    }

    // 删除单条记录（更加健壮的实现）
    // 删除单条记录：在内存中删除并在 IndexedDB 执行 delete，返回 Promise
    async deleteRecord(recordId) {
        try {
            if (recordId === null || recordId === undefined || recordId === '') {
                console.warn('deleteRecord 调用时 recordId 为空:', recordId);
                return false;
            }

            // 规范化 id（保留原有兼容性判断）
            const idStr = String(recordId).trim();
            const targetNum = Number(recordId);

            const originalLength = this.records.length;

            // 先按字符串匹配删除内存中的记录
            this.records = this.records.filter(r => String(r.id) !== idStr);

            // 如果没有删除任何记录，再尝试按数值匹配（兼容旧数据）
            if (this.records.length === originalLength && !Number.isNaN(targetNum)) {
                this.records = this.records.filter(r => {
                    const currentNum = Number(r.id);
                    return Number.isNaN(currentNum) || currentNum !== targetNum;
                });
            }

            const deletedCount = originalLength - this.records.length;

            if (deletedCount === 0) {
                console.warn('未找到要删除的记录，recordId =', recordId);
                return false;
            }

            // 执行 IndexedDB 删除（尝试用原始 key 和数值 key）
            try {
                await this._openDB().then(db => {
                    return new Promise((resolve, reject) => {
                        const tx = db.transaction(this._storeName, 'readwrite');
                        const store = tx.objectStore(this._storeName);
                        // 优先使用原始 recordId（字符串或数字），IndexedDB 会根据 key 类型匹配
                        try {
                            store.delete(recordId);
                            if (!Number.isNaN(targetNum) && String(targetNum) !== String(recordId)) {
                                // 也尝试数值形式，防止 key 类型不匹配
                                store.delete(targetNum);
                            }
                        } catch (e) {
                            console.error('执行 store.delete 时异常:', e);
                        }
                        tx.oncomplete = () => resolve(true);
                        tx.onerror = () => reject(tx.error || new Error('transaction 删除失败'));
                    });
                });
            } catch (err) {
                console.error('IndexedDB 删除记录失败:', err);
                // 写入失败但内存已删除：可选择重试或记录错误，这里返回 false 以便调用者提示
                return false;
            }

            console.log(`成功删除 ${deletedCount} 条记录，recordId =`, recordId);
            return true;
        } catch (error) {
            console.error('删除单条记录时发生异常:', error, 'recordId =', recordId);
            return false;
        }
    }

    // 获取车牌的运营记录
    getBusHistory(busId) {
        return this.records
            .filter(record => record.busId === busId)
            .sort((a, b) => new Date(b.date) - new Date(a.date));
    }

    // 获取统计信息
    getStatistics() {
        const totalRecords = this.records.length;
        const uniqueBuses = new Set(this.records.map(r => r.busId)).size;
        const uniqueLines = new Set(this.records.map(r => r.lineName)).size;

        return {
            totalRecords,
            uniqueBuses,
            uniqueLines
        };
    }

    // 计算存储占用大小
    getStorageSize() {
        try {
            const recordsData = JSON.stringify(this.records);
            const sizeInBytes = new Blob([recordsData]).size;
            const sizeInKB = sizeInBytes / 1024;
            const sizeInMB = sizeInKB / 1024;

            if (sizeInMB >= 1) {
                return `${sizeInMB.toFixed(2)}MB`;
            } else if (sizeInKB >= 1) {
                return `${sizeInKB.toFixed(2)}KB`;
            } else {
                return `${sizeInBytes}B`;
            }
        } catch (error) {
            console.error('计算存储大小失败:', error);
            return '计算失败';
        }
    }

    // 获取车牌对应的车型信息
    getVehicleType(busId) {
        try {
            // 尝试从全局的vehicleTypes对象获取车型信息
            if (typeof window.vehicleTypes === 'object' && window.vehicleTypes) {
                return window.vehicleTypes[busId] || null;
            }
            return null;
        } catch (error) {
            console.error('获取车型信息失败:', error);
            return null;
        }
    }

    // 清除旧记录（保留最近 N 天），按记录删除并等待持久化完成
    async cleanOldRecords(days = 30) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);
        const cutoffString = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, '0')}-${String(cutoffDate.getDate()).padStart(2, '0')}`;

        // 收集需删除的 id 列表
        const idsToDelete = this.records.filter(record => record.date < cutoffString).map(r => r.id);
        if (idsToDelete.length === 0) return 0;

        // 先在内存中过滤掉这些记录，减少并发时的可见性问题
        this.records = this.records.filter(record => record.date >= cutoffString);

        try {
            // 批量在 DB 中删除
            await this._deleteRecordsByIds(idsToDelete);
            return idsToDelete.length;
        } catch (err) {
            console.error('cleanOldRecords 批量删除失败:', err);
            // 出错时无法保证一致性，返回 0 或抛出根据调用方需要
            throw err;
        }
    }

    // 清空今日记录，按记录删除并等待完成
    async clearTodayRecords() {
        try {
            const now = new Date();
            const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            
            const idsToDelete = this.records.filter(record => record.date === today).map(r => r.id);
            if (idsToDelete.length === 0) {
                return { success: true, deletedCount: 0 };
            }

            // 在内存中先移除
            this.records = this.records.filter(record => record.date !== today);

            // 在 DB 中批量删除
            await this._deleteRecordsByIds(idsToDelete);
            console.log(`成功清空今日记录，删除了 ${idsToDelete.length} 条记录`);
            return { success: true, deletedCount: idsToDelete.length };
        } catch (error) {
            console.error('清空今日记录失败:', error);
            return { success: false, deletedCount: 0 };
        }
    }

    // 清空所有记录，并等待 DB 清除完成
    async clearAllRecords() {
        try {
            this.records = [];
            await this._clearAllInDB();
            return true;
        } catch (error) {
            console.error('清空记录失败:', error);
            return false;
        }
    }

    // 标准化线路名称，解决重复存储问题
    normalizeLineName(lineName) {
        if (!lineName || String(lineName).trim() === '') return '占位线';
        
        let normalized = String(lineName).trim();
        
        // 只进行基本的格式清理，不强制统一格式
        if (normalized === '占位线') {
            // 占位线，保持不变
            return normalized;
        } else {
            // 其他格式，保持原样但去除多余空格
            normalized = normalized.replace(/\s+/g, '');
        }
        
        return normalized;
    }

    // 应用线路名重命名规则，与单次查询保持一致
    applyLineNameRenaming(lineName) {
        if (!lineName || String(lineName).trim() === '') return '占位线';
        
        // 处理线路名称：转为大写，根据规则处理"路"字，并处理特殊线路名称
        let formattedLineName = String(lineName).toUpperCase();
        
        // 如果是旅游直通车X号线，则只去掉号线，其他保持不变（与 index.html 保持一致）
        if (formattedLineName.includes('旅游') && formattedLineName.includes('号线')) {
            formattedLineName = formattedLineName.replace('号线', '');
        } else {
            // 其他情况下删除"直通车"文本
            formattedLineName = formattedLineName.replace('直通车', '');
        }
        
        // 如果线路名称是数字+路+文字格式，则保留"路"字，否则删除"路"字
        if (!/^\d+路.+$/.test(formattedLineName)) {
            formattedLineName = formattedLineName.replace('路', '');
        }
        
        return formattedLineName;
    }

    // 清理重复的旅游直通车线路记录（合并同一车牌同一日期的旧记录）
    // 将"旅游X线"合并到"旅游直通车X"，统一为新命名格式
    async mergeDuplicateTouristRecords() {
        if (!this.records || this.records.length === 0) return 0;

        const toRemove = new Set();
        const oldPattern = /旅游\d+线/; // 旧的命名格式（如"旅游1线"、"旅游2线"）

        for (const record of this.records) {
            if (!oldPattern.test(record.lineName)) continue;

            // 尝试找到对应的"旅游直通车X"记录（同一车牌、同一日期）
            const normalizedOldName = record.lineName; // e.g. "旅游1线"
            const potentialNewName = normalizedOldName.replace('旅游', '旅游直通车').replace('线', ''); // e.g. "旅游直通车1"

            const duplicate = this.records.find(r =>
                r.busId === record.busId &&
                r.lineName === potentialNewName &&
                r.date === record.date &&
                r.id !== record.id
            );

            if (duplicate) {
                // 标记旧记录待删除
                toRemove.add(record.id);
                console.log(`合并重复记录: ${record.busId} ${record.lineName} -> ${potentialNewName}`);
            }
        }

        if (toRemove.size > 0) {
            this.records = this.records.filter(r => !toRemove.has(r.id));
            if (this._db) {
                try {
                    const tx = this._db.transaction(this._storeName, 'readwrite');
                    const store = tx.objectStore(this._storeName);
                    for (const id of toRemove) {
                        store.delete(id);
                    }
                    await new Promise((resolve, reject) => {
                        tx.oncomplete = resolve;
                        tx.onerror = () => reject(tx.error);
                    });
                } catch (e) {
                    console.warn('从 IndexedDB 删除重复记录失败:', e);
                }
            }
        }

        return toRemove.size;
    }

    // ===================== 车牌代号纠正功能 =====================

    // 初始化车牌代号映射表（从 vehicleTypes 中提取）
    initBusIdCorrectionMap() {
        if (this._busIdCorrectionMap) return;

        this._busIdCorrectionMap = {}; // 代号 -> 完整车牌
        this._correctionEnabled = true; // 纠正功能开关

        // 检查 vehicleTypes 是否存在
        if (typeof window.vehicleTypes !== 'object' || !window.vehicleTypes) {
            console.warn('vehicleTypes 未定义，车牌代号纠正功能不可用');
            return;
        }

        // 遍历车牌库，处理所有车牌
        for (const busId in window.vehicleTypes) {
            // 处理以 D 结尾的车牌（苏G0xxxD 格式）
            if (busId.endsWith('D')) {
                // 生成代号：去掉前导0
                const code = this.generateBusIdCode(busId);
                if (code && !this._busIdCorrectionMap[code]) {
                    this._busIdCorrectionMap[code] = busId;
                }
            }
            
            // 处理以 A 结尾的车牌（苏GA39139 格式，3开头5位数字为代号）
            if (busId.endsWith('A')) {
                // 生成代号：提取数字部分
                const match = busId.match(/^苏GA(\d+)$/);
                if (match) {
                    const code = match[1];
                    if (code && !this._busIdCorrectionMap[code]) {
                        this._busIdCorrectionMap[code] = busId;
                    }
                }
            }
        }

        console.log(`车牌代号纠正功能已初始化，共 ${Object.keys(this._busIdCorrectionMap).length} 个 D/A 结尾车牌`);
    }

    // 生成车牌的代号（去掉前导0）
    generateBusIdCode(busId) {
        if (!busId || typeof busId !== 'string') return null;

        // 匹配苏G开头的车牌，提取数字部分
        const match = busId.match(/^苏G0*(\d+)D$/);
        if (match) {
            return match[1]; // 返回去掉前导0的数字部分
        }

        return null;
    }

    // 纠正车牌代号为核心车牌
    // 如果 busId 是3开头5位数字代号，则纠正为苏GA格式（3=A）
    correctBusId(busId) {
        if (!busId || !this._correctionEnabled) return busId;

        // 如果未初始化，先初始化
        if (!this._busIdCorrectionMap) {
            this.initBusIdCorrectionMap();
        }

        // 规则1：3开头5位数字纠正为苏GA格式（3=A，纯黄车牌）
        if (/^3\d{4}$/.test(busId)) {
            // 先在映射表中查找
            const corrected = this._busIdCorrectionMap[busId];
            if (corrected) {
                console.log(`[车牌纠正-纯黄] ${busId} -> ${corrected}`);
                return corrected;
            }
            // 映射表中没有，3替换为A直接生成
            const generated = '苏G' + busId.replace('3', 'A');
            console.log(`[车牌纠正-纯黄生成] ${busId} -> ${generated}`);
            return generated;
        }

        // 规则2：其他纯数字代号在映射表中查找
        if (/^\d+$/.test(busId)) {
            const corrected = this._busIdCorrectionMap[busId];
            if (corrected) {
                console.log(`[车牌纠正] 代号 ${busId} -> ${corrected}`);
                return corrected;
            } else {
                // 如果在映射表中找不到，尝试模糊匹配（更宽松的匹配）
                const fuzzyCorrected = this.fuzzyCorrectBusId(busId);
                if (fuzzyCorrected) {
                    return fuzzyCorrected;
                }
            }
        }

        return busId;
    }

    // 模糊匹配：尝试匹配去掉更多0后的代号
    fuzzyCorrectBusId(code) {
        if (!code || !this._busIdCorrectionMap) return null;

        // 尝试逐个字符减少0来匹配
        for (let i = 0; i < code.length; i++) {
            if (code[i] === '0') {
                const shorterCode = code.substring(i + 1);
                const corrected = this._busIdCorrectionMap[shorterCode];
                if (corrected) {
                    console.log(`[车牌纠正-模糊] 代号 ${code} -> ${corrected} (通过${i+1}个0匹配)`);
                    return corrected;
                }
            }
        }

        return null;
    }

    // 批量纠正车牌列表中的代号
    correctBusIds(busList) {
        if (!Array.isArray(busList)) return busList;

        return busList.map(bus => {
            if (bus && bus.busId) {
                return {
                    ...bus,
                    busId: this.correctBusId(bus.busId)
                };
            }
            return bus;
        });
    }

    // 启用车牌代号纠正功能
    enableBusIdCorrection() {
        this._correctionEnabled = true;
        console.log('车牌代号纠正功能已启用');
    }

    // 禁用车牌代号纠正功能
    disableBusIdCorrection() {
        this._correctionEnabled = false;
        console.log('车牌代号纠正功能已禁用');
    }

    // 获取纠正统计信息
    getCorrectionStats() {
        if (!this._busIdCorrectionMap) {
            this.initBusIdCorrectionMap();
        }
        return {
            enabled: this._correctionEnabled,
            mapSize: Object.keys(this._busIdCorrectionMap || {}).length
        };
    }
}

// 模态窗口管理
class BusRecordsModal {
    constructor() {
        this.isOpen = false;
        this.searchDebounceTimer = null; // 添加搜索防抖计时器
        this.scrollListener = null; // 保存滚动监听器引用
        // 虚拟滚动相关
        this.virtualScrolling = {
            itemHeight: null, // 每行高度（动态计算）
            visibleCount: 20, // 预估可见行数
            bufferCount: 10, // 缓冲行数（上下各多渲染几行）
            scrollTop: 0,
            processedRecords: [], // 处理后的记录
            lastRenderRange: { start: -1, end: -1 }, // 上次渲染的范围
            debutBusIds: new Set(), // 今日首秀车号集合
            contentTbody: null, // 虚拟滚动的内容 tbody（同一 table 内的第二个 tbody）
            spacerTbody: null, // 虚拟滚动的占位 tbody
            table: null, // 所在的 table
            resizeHandler: null // 视口尺寸变化的监听函数
        };
        this.todayDebutMode = false; // 今日首秀筛选模式
        // 缓存处理结果
        this.recordsCache = {
            lastRecordsHash: null,
            processedRecords: null
        };
        // 统计信息缓存
        this.statsCache = {
            lastStatsHash: null,
            stats: null
        };
    }

    init() {
        this.createModalHTML();
        this.bindEvents();
        // 不再自动清理旧记录，改为手动操作
        // busRecordsManager.cleanOldRecords();
    }

    // 验证服务器地址（支持IP和域名）
    isValidServerAddress(address) {
        if (!address || typeof address !== 'string') {
            return false;
        }
        
        address = address.trim();
        
        // IP地址正则表达式
        const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
        
        // 域名正则表达式（支持子域名、国际域名等）
        const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/;
        
        // 检查是否为有效的IP地址或域名
        return ipRegex.test(address) || domainRegex.test(address);
    }

    // 格式化时间差为X分X秒格式
    formatDuration(milliseconds) {
        const totalSeconds = Math.floor(milliseconds / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        
        if (minutes > 0) {
            return `${minutes}分${seconds}秒`;
        } else {
            return `${seconds}秒`;
        }
    }

    createModalHTML() {
        const modalHTML = `
            <div id="busRecordsModal" class="bus-records-modal" style="display: none;">
                <div class="bus-records-content">
                    <div class="bus-records-header">
                        <h2>车辆管理</h2>
                        <span class="bus-records-close">&times;</span>
                    </div>
                    <div class="bus-records-search">
                        <div class="search-row">
                            <select id="searchType">
                                <option value="all">全部</option>
                                <option value="busId">车牌号</option>
                                <option value="lineName">线路名称</option>
                                <option value="vehicleType">车型</option>
                            </select>
                            <div class="search-input-wrapper">
                                <input type="text" id="searchTerm" placeholder="输入关键词">
                                <button id="searchClearBtn" class="search-clear-btn" style="display: none;">×</button>
                            </div>
                            <button id="todayDebutBtn">今日首秀</button>
                            <div class="menu-container">
                                <button id="menuBtn" title="菜单">☰</button>
                                <div id="menuDropdown" class="menu-dropdown" style="display: none;">
                                    <div class="menu-item" data-action="clean-old">清理30天前数据</div>
                                    <div class="menu-item" data-action="clear-today">清空今日数据</div>
                                    <div class="menu-item" data-action="clear">清空所有记录</div>
                                    <div class="menu-item" data-action="import">导入数据</div>
                                    <div class="menu-item" data-action="export">导出数据</div>
                                    <div class="menu-item" data-action="batch-add">批量添加</div>
                                    <div class="menu-item" data-action="manual-add">手动添加</div>
                                </div>
                            </div>
                        </div>
                        <div class="search-row" id="searchRow2">
                            <select id="searchType2">
                                <option value="all">--</option>
                                <option value="busId">车牌号</option>
                                <option value="lineName">线路名称</option>
                                <option value="vehicleType">车型</option>
                            </select>
                            <div class="search-input-wrapper">
                                <input type="text" id="searchTerm2" placeholder="输入条件2或精确筛选">
                                <button id="searchTerm2ClearBtn" class="search-clear-btn" style="display: none;">×</button>
                            </div>
                            <label style="display: flex; align-items: center; gap: 0.5vw; font-size: 3vw; white-space: nowrap; cursor: pointer; user-select: none;">
                                <input type="checkbox" id="exactMatch2" style="width: 3.5vw; height: 3.5vw; cursor: pointer;">
                                精确
                            </label>
                        </div>
                        <div class="search-row">
                            <button id="addAllBtn" style="background-color: #2196F3;">查询所有线路</button>
                            <input type="date" id="searchDate" title="选择日期">
                        </div>
                        <div class="search-stats">
                            <span id="statsInfo">加载中...</span>
                        </div>
                        <div class="storage-info">
                            <span id="storageInfo">记录将占用您的储存空间，建议您定时清理，当前已占用：计算中...</span>
                        </div>
                    </div>
                    <div class="bus-records-list">
                        <div class="records-table-container">
                            <table class="records-table">
                                <thead>
                                    <tr>
                                        <th>车牌号</th>
                                        <th>线路</th>
                                        <th>日期</th>
                                    </tr>
                                </thead>
                                <tbody id="recordsTableBody">
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const styleHTML = `
            <style>
                .bus-records-modal {
                    display: none;
                    position: fixed;
                    z-index: 1001;
                    left: 0;
                    top: 0;
                    width: 100%;
                    height: 100%;
                    background-color: rgba(0,0,0,0.5);
                    opacity: 0;
                    transition: opacity 0.3s ease-out;
                }

                .bus-records-modal.show {
                    opacity: 1;
                }

                .bus-records-content {
                    background-color: #fefefe;
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    margin: 0;
                    border: 0.2vw solid #888;
                    width: 90%;
                    max-width: 90vw;
                    /* 用 --app-vh（真实可见高度）而不是 85vh：
                       iOS 的 100vh 是地址栏收起时的最大视口高度，比实际可见区大，
                       直接用 vh 会让弹窗比屏幕还高，顶部被切掉。
                       --app-vh 由 index.html 中的 visualViewport 逻辑实时写入。 */
                    max-height: calc(var(--app-vh, 100vh) * 0.85);
                    border-radius: 2vw;
                    overflow: hidden;
                    display: flex;
                    flex-direction: column;
                    transform: translate(-50%, -50%) scale(0.9);
                    opacity: 0;
                    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease-out;
                    will-change: transform, opacity;
                }

                .bus-records-modal.show .bus-records-content {
                    transform: translate(-50%, -50%) scale(1);
                    opacity: 1;
                }

                .bus-records-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 5vw;
                    background-color: #f5f5f5;
                    border-bottom: 0.2vw solid #ddd;
                }

                .bus-records-header h2 {
                    margin: 0;
                    font-size: 5.5vw;
                    font-family: 'FZH', sans-serif;
                }

                .bus-records-close {
                    color: #aaa;
                    font-size: 7.5vw;
                    font-weight: bold;
                    cursor: pointer;
                }

                .bus-records-close:hover {
                    color: black;
                }

                .bus-records-search {
                    padding: 4vw 5vw;
                    background-color: #f9f9f9;
                    border-bottom: 0.2vw solid #ddd;
                }

                .search-row {
                    display: flex;
                    gap: 2vw;
                    margin-bottom: 2.5vw;
                    flex-wrap: nowrap;
                    align-items: center;
                }

                .search-row select, .search-row input, .search-row button {
                    padding: 1.5vw 2vw;
                    border: 0.2vw solid #ddd;
                    border-radius: 1vw;
                    font-size: 3.8vw;
                    font-family: 'FZH', sans-serif;
                    height: 9vw;
                    box-sizing: border-box;
                }

                .search-row select {
                    flex: 0 0 auto;
                    min-width: 15vw;
                    max-width: 20vw;
                }

                .search-row input[type="text"] {
                    flex: 1;
                    min-width: 18vw;
                }

                .search-input-wrapper {
                    flex: 1;
                    min-width: 18vw;
                    position: relative;
                    display: flex;
                    align-items: center;
                }

                .search-input-wrapper input[type="text"] {
                    width: 100%;
                    padding-right: 8vw;
                    box-sizing: border-box;
                }

                .search-clear-btn {
                    position: absolute;
                    right: 1vw;
                    width: 5vw !important;
                    height: 5vw !important;
                    min-width: 5vw !important;
                    max-width: 5vw !important;
                    padding: 0 !important;
                    background-color: #999 !important;
                    color: white !important;
                    border: none !important;
                    border-radius: 50% !important;
                    font-size: 3.5vw !important;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    line-height: 1;
                    flex: 0 0 auto !important;
                }

                .search-clear-btn:hover {
                    background-color: #d32f2f !important;
                }

                .search-row input[type="date"] {
                    flex: 1;
                    max-width: none;
                    font-size: 2.8vw;
                }

                .search-row button {
                    background-color: #4CAF50;
                    color: white;
                    border: none;
                    cursor: pointer;
                    flex: 0 0 auto;
                    min-width: 15vw;
                    max-width: 20vw;
                }

                /* 第二行按钮和日期选择器各占一半 */
                .search-row button#addAllBtn {
                    flex: 1;
                    max-width: none;
                    background-color: #2196F3;
                }

                #searchRow2 select, #searchRow2 input {
                    height: 9vw;
                    font-size: 3.5vw;
                }

                #searchRow2 select {
                    min-width: 12vw;
                    max-width: 16vw;
                }

                .search-row input[type="date"] {
                    flex: 1;
                    max-width: none;
                }

                .search-row button#menuBtn {
                    background-color: #607D8B;
                    font-size: 4.5vw;
                    font-weight: bold;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                .search-row button#menuBtn:hover {
                    background-color: #455A64;
                }

                .search-row button#todayDebutBtn {
                    background-color: #9C27B0;
                    color: white;
                    border: none;
                    cursor: pointer;
                    flex: 0 0 auto;
                    min-width: 17vw;
                    font-size: 3.8vw;
                    font-family: 'FZH', sans-serif;
                    font-weight: bold;
                    padding: 1.5vw 2vw;
                    border-radius: 1vw;
                    height: 9vw;
                    box-sizing: border-box;
                }

                .search-row button#todayDebutBtn:hover {
                    background-color: #7B1FA2;
                }

                .search-row button#todayDebutBtn.active {
                    background-color: #E91E63;
                }

                .search-row button#todayDebutBtn.active:hover {
                    background-color: #C2185B;
                }

                .search-row button#addAllBtn:hover {
                    background-color: #1976D2;
                }

                .search-stats {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    font-size: 3.5vw;
                    color: #666;
                }

                .search-stats button {
                    padding: 1.5vw 3vw;
                    background-color: #2196F3;
                    color: white;
                    border: none;
                    border-radius: 1vw;
                    cursor: pointer;
                    font-size: 3.5vw;
                    font-family: 'FZH', sans-serif;
                }

                .search-stats button:hover {
                    background-color: #1976D2;
                }

                .storage-info {
                    margin-top: 1.5vw;
                    text-align: center;
                }

                .storage-info span {
                    font-size: 2.8vw;
                    color: #888;
                    font-family: 'FZH', sans-serif;
                    line-height: 1.2;
                }

                .bus-records-list {
                    flex: 1;
                    overflow: hidden;
                    display: flex;
                    flex-direction: column;
                    padding: 5vw;
                }

                .records-table-container {
                    flex: 1;
                    overflow-y: auto;
                    border: 0.2vw solid #ddd;
                    border-radius: 1vw;
                    /* 虚拟滚动的内容 tbody 以本容器为绝对定位基准 */
                    position: relative;
                    overflow-x: hidden;
                }

                /* 虚拟滚动用的占位 tbody：
                   只放一个高度 = 记录总高度的空行，
                   专门把容器撑出可滚动的高度，本身不可见。 */
                .records-placeholder-body td {
                    padding: 0 !important;
                    border: none !important;
                }

                /* 虚拟滚动的内容 tbody：
                   与占位 tbody 同属一张 table，是合法的第二个 tbody。
                   绝对定位到表格起点，再用 transform 平移到对应滚动位置。
                   transform 只影响绘制、不触发布局，因此不会抖动，
                   也不会脱离弹窗跑到页面内容上。

                   注意：绝对定位的 <tbody> 会脱离表格的列宽算法，
                   单元格会退化成「按内容自适应」而变得很窄。
                   所以这里必须显式声明 display:table + 固定宽度，
                   并给单元格设定与表头一致的百分比列宽。 */
                .records-virtual-body {
                    position: absolute;
                    top: 0;
                    left: 0;
                    display: table;
                    table-layout: fixed;
                    width: 100%;
                    z-index: 2;
                    background-color: #fefefe;
                }

                /* 内容 tbody 里的单元格样式见下方
                   「.records-table td, .records-virtual-body td」合并规则，
                   这样媒体查询的字号/内边距改动能同时作用到两者。 */

                .records-virtual-body tr {
                    display: table-row;
                }

                .records-virtual-body td:nth-child(1) { width: 30%; }
                .records-virtual-body td:nth-child(2) { width: 45%; }
                .records-virtual-body td:nth-child(3) { width: 25%; }

                .records-table {
                    width: 100%;
                    border-collapse: collapse;
                    font-family: 'FZH', sans-serif;
                    table-layout: fixed;
                }

                .records-table th:nth-child(1),
                .records-table td:nth-child(1) {
                    width: 30%;
                }

                .records-table th:nth-child(2),
                .records-table td:nth-child(2) {
                    width: 45%;
                }

                .records-table th:nth-child(3),
                .records-table td:nth-child(3) {
                    width: 25%;
                }

                .records-table th {
                    background-color: #f5f5f5;
                    padding: 2vw 1vw;
                    text-align: left;
                    border-bottom: 0.5vw solid #ddd;
                    font-size: 4vw;
                    position: sticky;
                    top: 0;
                    z-index: 50;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                .records-table td {
                    padding: 1.5vw 1vw;
                    border-bottom: 0.2vw solid #eee;
                    font-size: 4vw;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                /* 内容 tbody 里的单元格必须和普通表格的 td 完全一致。
                   这里把 .records-virtual-body td 也纳入同一条选择器，
                   这样 @media (max-width: 480px) 里的
                   「font-size: 3vw; padding: 1.2vw 0.8vw」
                   也会同时作用到虚拟滚动的行上。
                   否则虚拟行会保持 4vw/1.5vw，
                   而测量行高时用的是 .records-table td 的 3vw/1.2vw，
                   两者不一致会造成滚动偏移错位，
                   表现为「显示的记录与实际位置对不上」。 */
                .records-table td,
                .records-virtual-body td {
                    display: table-cell;
                    padding: 1.5vw 1vw;
                    border-bottom: 0.2vw solid #eee;
                    font-size: 4vw;
                    font-family: 'FZH', sans-serif;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    vertical-align: middle;
                }

                .records-table td:nth-child(1),
                .records-table td:nth-child(2),
                .records-table td:nth-child(3) {
                    max-width: 0;
                }

                .records-table tr:hover {
                    background-color: #e3f2fd;
                    cursor: pointer;
                }

                .records-table tr.debut-gray {
                    background-color: #d8d8d8;
                }

                .records-table tr.debut-gray:hover {
                    background-color: #c8c8c8;
                }

                .records-table tbody tr:hover {
                    transform: scale(1.01);
                    box-shadow: 0 1vw 3vw rgba(0,0,0,0.1);
                    transition: all 0.2s ease;
                }

                .menu-container {
                    position: relative;
                    flex: 0 0 auto;
                }

                .menu-dropdown {
                    position: absolute;
                    top: 100%;
                    right: 0;
                    background-color: white;
                    border: 0.2vw solid #ddd;
                    border-radius: 1vw;
                    box-shadow: 0 2vw 8vw rgba(0,0,0,0.15);
                    z-index: 1000;
                    min-width: 30vw;
                    opacity: 0;
                    transform: translateY(-1vw);
                    transition: all 0.2s ease-out;
                    pointer-events: none;
                }

                .menu-dropdown.show {
                    opacity: 1;
                    transform: translateY(0);
                    pointer-events: auto;
                }

                .menu-item {
                    padding: 3vw 4vw;
                    font-size: 3.5vw;
                    font-family: 'FZH', sans-serif;
                    color: #333;
                    cursor: pointer;
                    border-bottom: 0.1vw solid #eee;
                    transition: background-color 0.2s ease;
                }

                .menu-item:last-child {
                    border-bottom: none;
                }

                .menu-item:hover {
                    background-color: #f5f5f5;
                }

                .menu-item[data-action="clear"] {
                    color: #d32f2f;
                }

                .menu-item[data-action="clear"]:hover {
                    background-color: #ffebee;
                    color: #b71c1c;
                }

                .menu-item[data-action="clean-old"] {
                    color: #ff9800;
                }

                .menu-item[data-action="clean-old"]:hover {
                    background-color: #fff3e0;
                    color: #f57c00;
                }

                .menu-item[data-action="clear-today"] {
                    color: #f57c00;
                }

                .menu-item[data-action="clear-today"]:hover {
                    background-color: #fff3e0;
                    color: #e65100;
                }

                .menu-item[data-action="today-debut"] {
                    color: #7b1fa2;
                    font-weight: bold;
                }

                .menu-item[data-action="today-debut"]:hover {
                    background-color: #f3e5f5;
                    color: #6a1b9a;
                }

                .search-row button#addAllBtn {
                    background-color: #2196F3;
                }

                @media (max-width: 768px) {
                    .bus-records-content {
                        margin: 2% auto;
                        width: 95%;
                        /* 同上：手机上更容易触发 iOS 的 vh 溢出问题 */
                        max-height: calc(var(--app-vh, 100vh) * 0.95);
                    }

                    .storage-info span {
                        font-size: 2.5vw;
                    }
                    
                    .search-row {
                        gap: 1.2vw;
                    }
                    
                    .search-row select {
                        min-width: 12vw;
                        max-width: 17vw;
                        font-size: 3.5vw;
                    }
                    
                    .search-row input[type="text"] {
                        min-width: 14vw;
                        font-size: 3.5vw;
                    }

                    .search-input-wrapper {
                        min-width: 14vw;
                    }

                    .search-input-wrapper input[type="text"] {
                        min-width: 14vw;
                        font-size: 3.5vw;
                    }

                    .search-clear-btn {
                        right: 1vw;
                        width: 4.5vw !important;
                        height: 4.5vw !important;
                        min-width: 4.5vw !important;
                        max-width: 4.5vw !important;
                        font-size: 3.2vw !important;
                    }
                    
                    .search-row button#todayDebutBtn {
                        min-width: 14vw;
                        font-size: 3.5vw;
                        padding: 1.5vw 1.5vw;
                    }
                    
                    .search-row input[type="date"] {
                        font-size: 3vw;
                    }
                    
                    .search-row button {
                        min-width: 12vw;
                        max-width: 17vw;
                        font-size: 3.5vw;
                        padding: 1.5vw 2vw;
                    }
                    
                    .search-row button#addAllBtn {
                        flex: 1;
                        max-width: none;
                    }

                    .records-table th {
                        font-size: 3vw;
                        padding: 1.5vw 0.8vw;
                    }

                    .records-table td {
                        font-size: 3vw;
                        padding: 1.2vw 0.8vw;
                    }

                    .menu-dropdown {
                        min-width: 35vw;
                        right: -2vw;
                    }

                    .menu-item {
                        padding: 2.5vw 3.5vw;
                        font-size: 3.2vw;
                    }

                    .search-row button#todayDebutBtn {
                        min-width: 13vw;
                        font-size: 3.2vw;
                    }
                }

                @media (max-width: 480px) {
                    .storage-info span {
                        font-size: 2.2vw;
                    }

                    .search-row {
                        gap: 1.2vw;
                    }
                    
                    .search-row select, .search-row input[type="text"] {
                        flex: 1 1 auto;
                        min-width: 15vw;
                    }

                    .search-input-wrapper {
                        flex: 1 1 auto;
                        min-width: 15vw;
                    }

                    .search-input-wrapper input[type="text"] {
                        flex: 1 1 auto;
                        min-width: 15vw;
                    }

                    .search-clear-btn {
                        right: 1vw;
                        width: 4.5vw !important;
                        height: 4.5vw !important;
                        min-width: 4.5vw !important;
                        max-width: 4.5vw !important;
                        font-size: 3.5vw !important;
                    }
                    
                    .search-row input[type="date"] {
                        flex: 1;
                    }
                    
                    .search-row button {
                        flex: 0 0 auto;
                    }
                    
                    .search-row button#addAllBtn {
                        flex: 1;
                        max-width: none;
                    }

                    .records-table th {
                        font-size: 3vw;
                        padding: 1.5vw 0.8vw;
                    }

                    .records-table td {
                        font-size: 3vw;
                        padding: 1.2vw 0.8vw;
                    }

                    .menu-dropdown {
                        min-width: 40vw;
                        right: -3vw;
                    }

                    .menu-item {
                        padding: 2vw 3vw;
                        font-size: 3vw;
                    }

                    .search-row button#todayDebutBtn {
                        min-width: 13vw;
                        font-size: 3.2vw;
                    }
                }
            </style>
        `;

        document.head.insertAdjacentHTML('beforeend', styleHTML);
        document.body.insertAdjacentHTML('beforeend', modalHTML);
    }

    bindEvents() {
        const modal = document.getElementById('busRecordsModal');
        const closeBtn = document.querySelector('.bus-records-close');
        const menuBtn = document.getElementById('menuBtn');
        const menuDropdown = document.getElementById('menuDropdown');
        const addAllBtn = document.getElementById('addAllBtn');
        const searchTerm = document.getElementById('searchTerm');
        const searchType = document.getElementById('searchType');
        const searchDate = document.getElementById('searchDate');

        closeBtn.addEventListener('click', () => this.close());
        modal.addEventListener('click', (e) => {
            if (e.target === modal) this.close();
        });

        // 菜单按钮事件
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleMenu();
        });

        // 今日首秀按钮事件
        const todayDebutBtn = document.getElementById('todayDebutBtn');
        if (todayDebutBtn) {
            todayDebutBtn.addEventListener('click', () => this.toggleTodayDebutMode());
        }

        // 点击其他地方关闭菜单
        document.addEventListener('click', (e) => {
            if (!menuDropdown.contains(e.target) && !menuBtn.contains(e.target)) {
                this.hideMenu();
            }
        });

        // 菜单项事件
        menuDropdown.addEventListener('click', (e) => {
            if (e.target.classList.contains('menu-item')) {
                const action = e.target.getAttribute('data-action');
                this.handleMenuAction(action);
                this.hideMenu();
            }
        });

        // 文本框自动搜索（带防抖）
        searchTerm.addEventListener('input', () => this.debouncedSearch());

        // 清除按钮：显示/隐藏
        const searchClearBtn = document.getElementById('searchClearBtn');
        searchTerm.addEventListener('input', () => {
            searchClearBtn.style.display = searchTerm.value ? 'flex' : 'none';
        });

        // 清除按钮：点击清空并搜索
        searchClearBtn.addEventListener('click', () => {
            searchTerm.value = '';
            searchClearBtn.style.display = 'none';
            this.performSearch();
        });

        // 下拉框改变时自动搜索
        searchType.addEventListener('change', () => this.performSearch());

        // 日期改变时自动搜索
        searchDate.addEventListener('change', () => this.performSearch());

        // 第二组筛选条件事件
        const searchTerm2 = document.getElementById('searchTerm2');
        const searchType2 = document.getElementById('searchType2');
        const exactMatch2 = document.getElementById('exactMatch2');
        if (searchTerm2) searchTerm2.addEventListener('input', () => this.debouncedSearch());
        if (searchType2) searchType2.addEventListener('change', () => this.performSearch());
        if (exactMatch2) exactMatch2.addEventListener('change', () => this.performSearch());

        // 条件2清除按钮
        const searchTerm2ClearBtn = document.getElementById('searchTerm2ClearBtn');
        if (searchTerm2) {
            searchTerm2.addEventListener('input', () => {
                searchTerm2ClearBtn.style.display = searchTerm2.value ? 'flex' : 'none';
            });
        }
        if (searchTerm2ClearBtn) {
            searchTerm2ClearBtn.addEventListener('click', () => {
                searchTerm2.value = '';
                searchTerm2ClearBtn.style.display = 'none';
                this.performSearch();
            });
        }

        addAllBtn.addEventListener('click', () => this.showAddAllDialog());
    }

    open() {
        if (this.isOpen) return;
        
        const modal = document.getElementById('busRecordsModal');
        const tbody = document.getElementById('recordsTableBody');
        const statsInfo = document.getElementById('statsInfo');
        
        // 先显示加载提示
        if (tbody) {
            // 打开前先清掉可能残留的虚拟滚动内容 tbody
            this.cleanupVirtualScrollBody();
            tbody.className = '';
            tbody.style.transform = '';
            tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: #666; padding: 20px;">加载中...</td></tr>';
        }
        if (statsInfo) {
            statsInfo.textContent = '加载中...';
        }
        
        // 显示弹窗并触发动画
        modal.style.display = 'block';
        
        // 强制重排以确保初始状态被应用
        void modal.offsetHeight;
        
        // 在下一帧添加 show 类触发动画
        requestAnimationFrame(() => {
            modal.classList.add('show');
            this.isOpen = true;
        });
        
        // 延迟加载数据，让弹窗动画先完成
        setTimeout(() => {
            this.todayDebutMode = false;
            const btn = document.getElementById('todayDebutBtn');
            if (btn) {
                btn.classList.remove('active');
                btn.textContent = '今日首秀';
            }
            const exactMatch1 = document.getElementById('exactMatch');
            if (exactMatch1) exactMatch1.checked = false;
            const exactMatch2 = document.getElementById('exactMatch2');
            if (exactMatch2) exactMatch2.checked = false;
            this.updateStatistics();
            this.loadRecords();
        }, 100);
    }

    close() {
        if (!this.isOpen) return;
        
        // 隐藏菜单
        this.hideMenu();
        
        const modal = document.getElementById('busRecordsModal');
        modal.classList.remove('show');
        
        // 清理滚动监听器
        if (this.scrollListener) {
            const container = document.querySelector('.records-table-container');
            if (container) {
                container.removeEventListener('scroll', this.scrollListener);
            }
            this.scrollListener = null;
        }
        
        // 清理虚拟滚动遗留的内容 tbody
        // （内容 tbody 是表格的兄弟节点，不在表格内部，必须单独移除）
        this.cleanupVirtualScrollBody();
        
        // 重置滚动位置
        const container = document.querySelector('.records-table-container');
        if (container) {
            container.scrollTop = 0;
        }
        
        // 重置虚拟滚动状态
        this.virtualScrolling.lastRenderRange = { start: -1, end: -1 };
        this.virtualScrolling.processedRecords = [];
        this.virtualScrolling.debutBusIds = new Set();
        
        setTimeout(() => {
            modal.style.display = 'none';
        }, 300);
        
        this.isOpen = false;
    }

    updateStatistics() {
        const statsInfo = document.getElementById('statsInfo');
        const storageInfo = document.getElementById('storageInfo');
        
        // 使用缓存的统计信息
        const recordsHash = this.getRecordsHash(busRecordsManager.records);
        let stats;
        
        if (this.statsCache.lastStatsHash === recordsHash && this.statsCache.stats) {
            stats = this.statsCache.stats;
        } else {
            stats = busRecordsManager.getStatistics();
            this.statsCache.lastStatsHash = recordsHash;
            this.statsCache.stats = stats;
        }
        
        if (stats.totalRecords === 0) {
            statsInfo.textContent = '暂无记录';
        } else if (this.todayDebutMode) {
            const today = this._getTodayString();
            const todayRecords = busRecordsManager.records.filter(r => r.date === today);
            const todayCount = todayRecords.length;
            const todayBuses = new Set(todayRecords.map(r => r.busId)).size;
            const todayLines = new Set(todayRecords.map(r => r.lineName)).size;
            statsInfo.textContent = `今日记录: ${todayCount} | 车辆: ${todayBuses} | 线路: ${todayLines}`;
        } else {
            statsInfo.textContent = `总记录: ${stats.totalRecords} | 车辆: ${stats.uniqueBuses} | 线路: ${stats.uniqueLines}`;
        }

        // 更新存储占用信息
        if (storageInfo) {
            const storageSize = busRecordsManager.getStorageSize();
            storageInfo.textContent = `记录将占用您的储存空间，建议您定时清理，当前已占用：${storageSize}`;
        }
    }

    // 防抖搜索函数
    debouncedSearch() {
        // 清除之前的计时器
        if (this.searchDebounceTimer) {
            clearTimeout(this.searchDebounceTimer);
        }
        
        // 设置新的计时器，500ms后执行搜索
        this.searchDebounceTimer = setTimeout(() => {
            this.performSearch();
        }, 500);
    }

    // 切换菜单显示状态
    toggleMenu() {
        const menuDropdown = document.getElementById('menuDropdown');
        if (menuDropdown.classList.contains('show')) {
            this.hideMenu();
        } else {
            this.showMenu();
        }
    }

    // 显示菜单
    showMenu() {
        const menuDropdown = document.getElementById('menuDropdown');
        menuDropdown.style.display = 'block';
        // 强制重绘
        menuDropdown.offsetHeight;
        menuDropdown.classList.add('show');
    }

    // 隐藏菜单
    hideMenu() {
        const menuDropdown = document.getElementById('menuDropdown');
        menuDropdown.classList.remove('show');
        setTimeout(() => {
            menuDropdown.style.display = 'none';
        }, 200);
    }

    // 处理菜单项点击
    handleMenuAction(action) {
        switch (action) {
            case 'clean-old':
                this.cleanOldRecords();
                break;
            case 'clear-today':
                this.clearTodayRecords();
                break;
            case 'clear':
                this.clearAllRecords();
                break;
            case 'import':
                this.showImportDialog();
                break;
            case 'export':
                this.showExportDialog();
                break;
            case 'batch-add':
                this.showBatchAddDialog();
                break;
            case 'manual-add':
                this.showManualAddDialog();
                break;
            default:
                console.log('未知的菜单操作:', action);
        }
    }

    // 切换今日首秀模式
    toggleTodayDebutMode() {
        this.todayDebutMode = !this.todayDebutMode;
        const btn = document.getElementById('todayDebutBtn');
        if (this.todayDebutMode) {
            btn.classList.add('active');
            btn.textContent = '关闭';
            this.showTodayDebutView('', 'all', '', 'all', false);
        } else {
            btn.classList.remove('active');
            btn.textContent = '今日首秀';
            this.virtualScrolling.debutBusIds = new Set();
            this.performSearch();
        }
        this.updateStatistics();
    }

    showTodayDebutView(searchTerm, searchType, searchTerm2, searchType2, exactMatch2) {
        const today = this._getTodayString();
        const tenDaysAgo = this._getDateString(new Date(Date.now() - 10 * 24 * 3600 * 1000));

        const allRecords = busRecordsManager.records;
        let todayRecords = allRecords.filter(r => r.date === today);

        if (todayRecords.length === 0) {
            this.displayRecords([]);
            return;
        }

        // Build 10-day history for each busId (exclude today)
        const recentHistory = {};
        allRecords.forEach(r => {
            if (r.date >= tenDaysAgo && r.date < today) {
                if (!recentHistory[r.busId]) recentHistory[r.busId] = [];
                recentHistory[r.busId].push(r.lineName);
            }
        });

        // Determine which vehicles are debut
        const debutVehicles = new Set();
        todayRecords.forEach(r => {
            const hist = recentHistory[r.busId];
            if (!hist || hist.length === 0) {
                debutVehicles.add(r.busId);
            } else {
                const hasOverlap = hist.some(line => line === r.lineName);
                if (!hasOverlap) {
                    debutVehicles.add(r.busId);
                }
            }
        });

        // Mark debut on records
        let processedRecords = todayRecords.map(r => ({
            ...r,
            isDebut: debutVehicles.has(r.busId)
        }));

        // Apply search filters to today's records
        if (searchTerm) {
            const term = searchTerm.toLowerCase();
            processedRecords = processedRecords.filter(record => {
                switch (searchType) {
                    case 'busId':
                        return String(record.busId).toLowerCase().includes(term);
                    case 'lineName':
                        return String(record.lineName).toLowerCase().includes(term);
                    case 'vehicleType':
                        const vt = busRecordsManager.getVehicleType(record.busId);
                        return vt && vt.toLowerCase().includes(term);
                    case 'all':
                    default:
                        const allVt = busRecordsManager.getVehicleType(record.busId);
                        return String(record.busId).toLowerCase().includes(term) ||
                            String(record.lineName).toLowerCase().includes(term) ||
                            (allVt && allVt.toLowerCase().includes(term));
                }
            });
        }

        // Apply condition 2 filter
        if (searchType2 !== 'all' && searchTerm2) {
            const term2 = searchTerm2.toLowerCase();
            processedRecords = processedRecords.filter(record => {
                switch (searchType2) {
                    case 'busId':
                        return exactMatch2
                            ? String(record.busId).toLowerCase() === term2
                            : String(record.busId).toLowerCase().includes(term2);
                    case 'lineName':
                        return exactMatch2
                            ? String(record.lineName).toLowerCase() === term2
                            : String(record.lineName).toLowerCase().includes(term2);
                    case 'vehicleType':
                        const vt = busRecordsManager.getVehicleType(record.busId);
                        if (!vt) return false;
                        return exactMatch2
                            ? vt.toLowerCase() === term2
                            : vt.toLowerCase().includes(term2);
                    default:
                        return true;
                }
            });
        }

        // 分组：今日首秀标灰记录置顶，其余按日期倒序、车号排序
        const debutRecords = processedRecords.filter(r => r.isDebut);
        const nonDebutRecords = processedRecords.filter(r => !r.isDebut);
        const sortGroup = (a, b) => {
            if (a.date !== b.date) return b.date.localeCompare(a.date);
            return a.busId.localeCompare(b.busId);
        };
        debutRecords.sort(sortGroup);
        nonDebutRecords.sort(sortGroup);
        processedRecords = [...debutRecords, ...nonDebutRecords];

        // Store debut bus IDs for virtual scroll rendering
        this.virtualScrolling.debutBusIds = debutVehicles;

        // Show only today records with debut markers
        this.displayDebutRecords(processedRecords);
    }

    _getTodayString() {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    }

    _getDateString(date) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    displayDebutRecords(records) {
        const tbody = document.getElementById('recordsTableBody');
        if (!tbody) return;
        const debutContainer = tbody.closest('.records-table-container');
        if (records.length === 0) {
            // 空列表时也要清掉可能残留的虚拟滚动内容 tbody
            this.cleanupVirtualScrollBody();
            tbody.className = '';
            tbody.style.transform = '';
            tbody.style.position = '';
            tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: #666;">今日暂无记录</td></tr>';
            if (debutContainer) debutContainer.scrollTop = 0;
            return;
        }
        // 之前若启用过虚拟滚动，需先移除残留的内容 tbody，
        // 否则它会继续以绝对定位浮在表格上方。
        this.cleanupVirtualScrollBody();
        this.virtualScrolling.lastRenderRange = { start: -1, end: -1 };

        tbody.innerHTML = '';
        tbody.className = '';
        tbody.style.transform = '';
        tbody.style.position = '';
        const fragment = document.createDocumentFragment();
        records.forEach(record => {
            const row = this.createRecordRow(record);
            fragment.appendChild(row);
        });
        tbody.appendChild(fragment);
        // 搜索结果变了，滚动位置必须归零，否则显示的不是第一条结果
        if (debutContainer) debutContainer.scrollTop = 0;
    }

    performSearch() {
        if (this.todayDebutMode) {
            const searchType = document.getElementById('searchType').value;
            const searchTerm = document.getElementById('searchTerm').value.trim();
            const searchType2 = document.getElementById('searchType2')?.value || 'all';
            const searchTerm2 = document.getElementById('searchTerm2')?.value.trim() || '';
            const exactMatch2 = document.getElementById('exactMatch2')?.checked || false;
            this.showTodayDebutView(searchTerm, searchType, searchTerm2, searchType2, exactMatch2);
            return;
        }

        const searchType = document.getElementById('searchType').value;
        const searchTerm = document.getElementById('searchTerm').value.trim();
        const searchDate = document.getElementById('searchDate').value;

        const searchType2 = document.getElementById('searchType2')?.value || 'all';
        const searchTerm2 = document.getElementById('searchTerm2')?.value.trim() || '';

        let results = busRecordsManager.searchRecords(searchTerm, searchType, searchDate);

        // 第二组条件：AND 筛选
        if (searchType2 !== 'all' && searchTerm2) {
            const exactMatch2 = document.getElementById('exactMatch2')?.checked || false;
            const term2 = searchTerm2.toLowerCase();
            results = results.filter(record => {
                switch (searchType2) {
                    case 'busId':
                        return exactMatch2
                            ? String(record.busId).toLowerCase() === term2
                            : String(record.busId).toLowerCase().includes(term2);
                    case 'lineName':
                        return exactMatch2
                            ? String(record.lineName).toLowerCase() === term2
                            : String(record.lineName).toLowerCase().includes(term2);
                    case 'vehicleType':
                        const vt = busRecordsManager.getVehicleType(record.busId);
                        if (!vt) return false;
                        return exactMatch2
                            ? vt.toLowerCase() === term2
                            : vt.toLowerCase().includes(term2);
                    default:
                        return true;
                }
            });
        }

        this.displayRecords(results);
    }

    loadRecords() {
        const records = busRecordsManager.records.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        this.displayRecords(records);
    }

    // 生成记录的哈希值，用于判断数据是否变化
    //
    // 注意：这里必须能区分「不同的搜索结果集合」。
    // 之前只用「条数 + 首条 id + 末条 id」，
    // 两组不同的搜索结果完全可能长度相同、首末 id 也相同
    // （比如都从同一条记录开始、到同一条记录结束），
    // 这时就会误命中缓存，把上一次搜索的处理结果当成这次的，
    // 表现为「搜索出来的记录和列表里显示的对不上」。
    // 改为把每条记录的 id 都算进哈希，保证结果集合唯一。
    getRecordsHash(records) {
        if (!records || records.length === 0) return 'empty';
        let hash = records.length;
        for (let i = 0; i < records.length; i++) {
            hash = (hash * 31 + (records[i]?.id || 0)) | 0;
        }
        return 'h' + hash;
    }

    // 清除所有缓存
    clearCache() {
        this.recordsCache = {
            lastRecordsHash: null,
            processedRecords: null
        };
        this.statsCache = {
            lastStatsHash: null,
            stats: null
        };
        this.virtualScrolling.lastRenderRange = { start: -1, end: -1 };
        this.virtualScrolling.debutBusIds = new Set();
        this.todayDebutMode = false;
    }

    // 处理记录：分组、排序等
    processRecordsForDisplay(records) {
        // 检查缓存
        const recordsHash = this.getRecordsHash(records);
        if (this.recordsCache.lastRecordsHash === recordsHash && this.recordsCache.processedRecords) {
            return this.recordsCache.processedRecords;
        }

        // 按车牌号和日期组合分组
        const groupedRecords = {};
        records.forEach(record => {
            const key = `${record.busId}_${record.date}`;
            if (!groupedRecords[key]) {
                groupedRecords[key] = [];
            }
            groupedRecords[key].push(record);
        });

        // 处理每个分组，只保留最新的前两条线路记录
        const processedRecords = [];
        Object.keys(groupedRecords).forEach(key => {
            const groupRecords = groupedRecords[key];
            
            // 按时间戳排序，最新的在前
            groupRecords.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            
            // 获取不重复的线路名称，最多取前两个
            const uniqueLines = [];
            const seenLines = new Set();
            
            // 先统计所有不重复的线路
            for (const record of groupRecords) {
                if (!seenLines.has(record.lineName)) {
                    seenLines.add(record.lineName);
                }
            }
            
            // 取前两个线路用于显示
            const totalUniqueLines = seenLines.size;
            let displayLineCount = 0;
            for (const record of groupRecords) {
                if (!uniqueLines.includes(record.lineName)) {
                    uniqueLines.push(record.lineName);
                    displayLineCount++;
                    if (displayLineCount >= 2) break;
                }
            }
            
            // 如果有超过2条线路，在后面加上"等"字
            let displayLineName = uniqueLines.join('、');
            if (totalUniqueLines > 2) {
                displayLineName += '　等';
            }
            
            // 创建显示记录
            const displayRecord = {
                busId: groupRecords[0].busId,
                lineName: displayLineName,
                date: groupRecords[0].date,
                originalRecords: groupRecords
            };
            
            processedRecords.push(displayRecord);
        });

        // 按日期和时间戳排序，最新的在前
        processedRecords.sort((a, b) => {
            const dateCompare = new Date(b.date) - new Date(a.date);
            if (dateCompare !== 0) return dateCompare;
            return new Date(b.originalRecords[0].timestamp) - new Date(a.originalRecords[0].timestamp);
        });

        // 缓存处理结果
        this.recordsCache.lastRecordsHash = recordsHash;
        this.recordsCache.processedRecords = processedRecords;

        return processedRecords;
    }

    displayRecords(records) {
        const tbody = document.getElementById('recordsTableBody');
        if (!tbody) return;
        
        if (records.length === 0) {
            // 空列表时也要清掉可能残留的虚拟滚动内容 tbody
            this.cleanupVirtualScrollBody();
            tbody.className = '';
            tbody.style.transform = '';
            tbody.style.position = '';
            tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: #666;">暂无记录</td></tr>';
            // 结果为空后容器可能停在旧位置，一并归零
            const emptyContainer = tbody.closest('.records-table-container');
            if (emptyContainer) emptyContainer.scrollTop = 0;
            return;
        }

        // 处理记录（使用缓存）
        const processedRecords = this.processRecordsForDisplay(records);
        
        // 如果记录数量少于50条，直接全部渲染（无需虚拟滚动）
        if (processedRecords.length <= 50) {
            this.renderAllRecords(tbody, processedRecords);
            return;
        }

        // 启用虚拟滚动
        this.virtualScrolling.processedRecords = processedRecords;
        this.setupVirtualScrolling(tbody);
    }
    // 直接渲染所有记录（记录少时使用）
    renderAllRecords(tbody, processedRecords) {
        // 之前若启用过虚拟滚动，需先移除残留的内容 tbody，
        // 否则它会继续以绝对定位浮在表格上方。
        this.cleanupVirtualScrollBody();
        this.virtualScrolling.lastRenderRange = { start: -1, end: -1 };

        // 必须清掉占位 tbody 留下的痕迹：
        //   className = 'records-placeholder-body' 会让所有 td 的
        //   padding 被 `padding: 0 !important` 压成 0（行变得很扁）；
        //   残留的 transform 则会让整张表整体错位。
        tbody.className = '';
        tbody.style.transform = '';
        tbody.style.position = '';
        tbody.innerHTML = '';

        const fragment = document.createDocumentFragment();
        
        processedRecords.forEach(record => {
            const row = this.createRecordRow(record);
            fragment.appendChild(row);
        });
        
        tbody.appendChild(fragment);

        // 结果变少后，容器可能仍停在旧的滚动位置（甚至超出新内容高度），
        // 必须回到顶部，否则屏幕上看到的不是第一条搜索结果。
        const container = tbody.closest('.records-table-container');
        if (container) {
            container.scrollTop = 0;
        }
    }

    // 创建单个记录行
    createRecordRow(record) {
        const row = document.createElement('tr');
        row.style.cursor = 'pointer';
        row.addEventListener('click', () => {
            this.showBusHistory(record.busId);
        });
        row.innerHTML = `
            <td>${record.busId}</td>
            <td>${record.lineName}</td>
            <td>${record.date}</td>
        `;
        // 支持今日首秀标灰
        if (record.isDebut || (this.virtualScrolling.debutBusIds && this.virtualScrolling.debutBusIds.size > 0 && this.virtualScrolling.debutBusIds.has(record.busId))) {
            row.classList.add('debut-gray');
        }
        return row;
    }

    // 清理虚拟滚动产生的「内容 tbody」
    // 虚拟滚动时，内容 tbody 是 <table> 内的第二个 tbody，
    // 关闭弹窗或重新渲染数据时必须把它移除，否则会残留空行。
    cleanupVirtualScrollBody() {
        const vs = this.virtualScrolling;
        if (vs && vs.contentTbody && vs.contentTbody.parentNode) {
            vs.contentTbody.parentNode.removeChild(vs.contentTbody);
        }
        // 【兜底】把表格里残留的所有 .records-virtual-body 全部移除。
        // 正常情况下 contentTbody 只有一个，但一旦因为异常路径
        // （例如连续搜索时中途抛错）留下了多余的，
        // 它们会同时绝对定位显示在表格上，造成记录重叠错乱。
        const table = vs && vs.table ? vs.table : document.getElementById('recordsTableBody')?.parentElement;
        if (table) {
            const leftovers = table.querySelectorAll('.records-virtual-body');
            leftovers.forEach(el => {
                if (el.parentNode) el.parentNode.removeChild(el);
            });
        }
        if (vs) {
            vs.contentTbody = null;
            // 占位 tbody 也要清空，避免残留超高占位行
            if (vs.spacerTbody) {
                vs.spacerTbody.innerHTML = '';
                vs.spacerTbody.className = '';
                vs.spacerTbody.style.transform = '';
                vs.spacerTbody.style.position = '';
            }
            vs.spacerTbody = null;
            vs.table = null;
            // 移除视口尺寸变化的监听
            if (vs.resizeHandler) {
                window.removeEventListener('resize', vs.resizeHandler);
                vs.resizeHandler = null;
            }
        }
    }

    // 设置虚拟滚动
    //
    // 【原实现的 bug】
    // 原代码往 <tbody> 里 appendChild 了一个 <div>，再给这个 div 设
    // position:absolute 来做偏移。但 <div> 是 <tbody> 的非法子元素，
    // 浏览器会把它「foster parenting」提升到 <table> 之外，
    // 于是绝对定位的表格脱离了弹窗的裁剪范围，直接压在页面内容上；
    // 同时 <tbody> 的占位高度也失效，列表无法滚动。
    // Chrome 对这种非法结构的容错表现与 iOS Safari 不同，
    // 所以只有 iOS 上「数据量大时」才崩。
    //
    // 【现在的实现】
    // 全部使用合法的表格结构，各浏览器行为一致：
    //   - 同一个 <table> 内的两个 <tbody>（HTML 允许 table 有多个 tbody）
    //   - 第一个 tbody 是「占位 tbody」：一个高度 = 记录总高度的空行，
    //     专门用来把容器撑出可滚动的高度
    //   - 第二个 tbody 是「内容 tbody」：只渲染可见区域的行，
    //     用 transform: translateY() 平移到对应的滚动位置
    //   transform 只影响绘制、不触发布局，比改 top 稳定，
    //   也不会像原来那样脱离弹窗。
    setupVirtualScrolling(tbody) {
        const container = tbody.closest('.records-table-container');
        const processedRecords = this.virtualScrolling.processedRecords;
        if (!container || !processedRecords.length) return;

        // 清理旧的滚动监听器
        if (this.scrollListener) {
            container.removeEventListener('scroll', this.scrollListener);
            this.scrollListener = null;
        }

        // 重置虚拟滚动状态
        this.virtualScrolling.lastRenderRange = { start: -1, end: -1 };

        // 【关键】必须先移除上一次遗留的「内容 tbody」。
        // 否则连续两次搜索（两次结果都超过 50 条、都会走虚拟滚动）时，
        // 表格里会同时存在两个 .records-virtual-body：
        // 它们都是 position:absolute，都会显示在表格上，
        // 于是屏幕上看到的是两层记录叠在一起，
        // 表现为「搜索结果和显示的记录不一致」「显示了不相关的记录」。
        // iOS Safari 上因为滚动/渲染时序不同，更容易连续触发这个问题。
        this.cleanupVirtualScrollBody();

        // 清空原 tbody，重建为「占位 tbody」
        tbody.innerHTML = '';
        tbody.className = 'records-placeholder-body';
        tbody.style.transform = '';
        tbody.style.position = '';

        const table = tbody.parentElement;
        if (!table) return;

        // 内容 tbody：同一张 table 内的第二个 tbody（合法结构）
        const contentTbody = document.createElement('tbody');
        contentTbody.className = 'records-virtual-body';
        table.appendChild(contentTbody);

        // 行高必须从「真正渲染出来的虚拟行」上测量。
        // 之前是在原 tbody 里插一行临时行来测量，
        // 而临时行属于 .records-table（受媒体查询影响），
        // 实际渲染的行属于 .records-virtual-body（当时未被媒体查询覆盖），
        // 两者高度不一致，导致滚动偏移逐渐错位、
        // 屏幕上显示的记录与实际位置对不上。
        // 这里先渲染一行到 contentTbody 里量高度，保证量到的就是真实高度。
        const measureItemHeight = () => {
            const probeRow = this.createRecordRow(processedRecords[0]);
            contentTbody.innerHTML = '';
            contentTbody.appendChild(probeRow);
            const h = probeRow.getBoundingClientRect().height
                   || probeRow.offsetHeight
                   || 0;
            contentTbody.innerHTML = '';
            return h > 0 ? h : (this.virtualScrolling.itemHeight || 1);
        };

        const itemHeight = measureItemHeight();
        this.virtualScrolling.itemHeight = itemHeight;
        const totalHeight = processedRecords.length * itemHeight;

        const spacerRow = document.createElement('tr');
        spacerRow.setAttribute('aria-hidden', 'true');
        const spacerCell = document.createElement('td');
        spacerCell.colSpan = 3;
        spacerCell.style.height = totalHeight + 'px';
        spacerCell.style.padding = '0';
        spacerCell.style.border = 'none';
        spacerRow.appendChild(spacerCell);
        tbody.appendChild(spacerRow);

        // 内容 tbody 是绝对定位，基准是 .records-table-container（position:relative），
        // 但表格本体在 thead（表头）下方才开始，
        // 所以要测出「表头底部」相对容器的偏移，作为内容层的起点，
        // 否则第一行会盖在表头上。
        const getContentTopOffset = () => {
            const thead = table.querySelector('thead');
            if (!thead) return 0;
            const containerRect = container.getBoundingClientRect();
            const headRect = thead.getBoundingClientRect();
            return Math.max(0, headRect.bottom - containerRect.top);
        };

        // 内容 tbody 脱离了表格的列宽算法，必须显式给出与表格等宽的宽度，
        // 否则 display:table 的列宽会退化成按内容自适应，导致每列都很窄。
        const syncContentWidth = () => {
            const tableWidth = table.getBoundingClientRect().width;
            const containerWidth = container.clientWidth;
            // 表格宽度可能因为出现横向滚动条而与容器有细微差异，
            // 这里以容器宽度为准，保证 30%/45%/25% 的百分比列宽与表头完全对齐。
            const w = containerWidth || tableWidth;
            if (w > 0) {
                contentTbody.style.width = w + 'px';
            }
        };
        syncContentWidth();
        contentTbody.style.top = getContentTopOffset() + 'px';

        // 渲染可见区域
        //
        // forceFromStart：强制从第 0 条开始渲染，不依赖 container.scrollTop。
        // 搜索换一批数据后必须这样处理，因为 iOS Safari 上
        // `container.scrollTop = 0` 是异步提交的，
        // 紧接着读 container.scrollTop 拿到的仍是旧值（例如 2000），
        // 于是 startIndex 按旧偏移算出来，
        // 屏幕上显示的是新结果集里「中间某几条」，
        // 看起来就像「搜索结果和显示的记录对不上」。
        // 所以搜索/换数据后的首次渲染一律从 0 开始，并强制清掉 transform 偏移。
        let forceFromStart = true;

        const renderVisibleRecords = () => {
            const scrollTop = forceFromStart ? 0 : container.scrollTop;
            const containerHeight = container.clientHeight || 1;

            // 窗口尺寸变化（iOS 地址栏收起/展开）后表头高度可能改变，
            // 重新校准内容层的起点与宽度，避免与表头错位或列宽失准。
            contentTbody.style.top = getContentTopOffset() + 'px';
            syncContentWidth();

            // 计算可见范围
            const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - this.virtualScrolling.bufferCount);
            const endIndex = Math.min(
                processedRecords.length,
                Math.ceil((scrollTop + containerHeight) / itemHeight) + this.virtualScrolling.bufferCount
            );

            // 如果范围没有变化，不重新渲染
            if (this.virtualScrolling.lastRenderRange.start === startIndex &&
                this.virtualScrolling.lastRenderRange.end === endIndex) {
                // 但如果还处在「强制从头」状态，必须把 transform 归零，
                // 否则上一次渲染残留的 translateY 偏移会作用在新数据上，
                // 导致整张表整体错位。
                if (forceFromStart) {
                    contentTbody.style.transform = 'translateY(0px)';
                    forceFromStart = false;
                }
                return;
            }

            this.virtualScrolling.lastRenderRange = { start: startIndex, end: endIndex };

            // 清空并渲染新的可见记录
            contentTbody.innerHTML = '';
            const fragment = document.createDocumentFragment();

            for (let i = startIndex; i < endIndex; i++) {
                const record = processedRecords[i];
                const row = this.createRecordRow(record);
                fragment.appendChild(row);
            }

            contentTbody.appendChild(fragment);

            // 调整位置：内容 tbody 整体平移到可见区域对应的偏移。
            // 内容 tbody 绝对定位在表格起点（top:0），因此向下平移
            // startIndex * itemHeight 就能让第一行正好落在滚动位置对应处。
            contentTbody.style.transform = 'translateY(' + (startIndex * itemHeight) + 'px)';
            forceFromStart = false;
        };

        // 重置滚动位置。
        // 搜索出新结果后，列表内容已经变了（条数、行高都可能变），
        // 必须回到顶部从第一条开始显示；
        // 否则会停在上一次的滚动偏移上，
        // 屏幕上第一条显示的是中间某条记录，
        // 看起来就像「搜索结果和显示的记录对不上」。
        //
        // iOS Safari 注意：scrollTop = 0 是异步提交的，
        // 复位后还会异步派发一个 scroll 事件。
        // 所以这里：
        //   1) 先把「强制从头渲染」的标记打开
        //   2) 复位 scrollTop
        //   3) 立即渲染一次（从第 0 条开始，transform 归零）
        //   4) 下一帧再强制渲染一次，
        //      确保 iOS 复位完成后不会用旧偏移再渲染一遍
        forceFromStart = true;
        container.scrollTop = 0;

        // 初始渲染
        renderVisibleRecords();

        // iOS 滚动复位是异步的，下一帧再强制渲染一次，
        // 避免复位完成后的 scroll 事件用旧偏移把内容带偏。
        requestAnimationFrame(() => {
            forceFromStart = true;
            this.virtualScrolling.lastRenderRange = { start: -1, end: -1 };
            renderVisibleRecords();
        });

        // 创建并保存滚动监听器（使用节流）
        let scrollTimer = null;
        this.scrollListener = () => {
            if (scrollTimer) return;
            scrollTimer = setTimeout(() => {
                renderVisibleRecords();
                scrollTimer = null;
            }, 16); // 约60fps
        };

        // 添加滚动监听
        container.addEventListener('scroll', this.scrollListener);

        // 视口尺寸变化时重新渲染（iOS 地址栏收起/展开会改变表头高度）
        if (this.virtualScrolling.resizeHandler) {
            window.removeEventListener('resize', this.virtualScrolling.resizeHandler);
        }
        this.virtualScrolling.resizeHandler = () => {
            this.virtualScrolling.lastRenderRange = { start: -1, end: -1 };
            renderVisibleRecords();
        };
        window.addEventListener('resize', this.virtualScrolling.resizeHandler);

        // 记录内容 tbody，便于关闭/刷新时清理
        this.virtualScrolling.contentTbody = contentTbody;
        this.virtualScrolling.spacerTbody = tbody;
        this.virtualScrolling.table = table;
    }

    showBusHistory(busId) {
        const history = busRecordsManager.getBusHistory(busId);
        const vehicleType = busRecordsManager.getVehicleType(busId);
        this.createBusHistoryModal(busId, history, vehicleType);
    }

    createBusHistoryModal(busId, history, vehicleType = null) {
        // 移除已存在的历史窗口
        const existingModal = document.getElementById('busHistoryModal');
        if (existingModal) {
            document.body.removeChild(existingModal);
        }

        // 构建标题，包含车型信息
        let titleText = `车辆历史记录 - ${busId}`;
        if (vehicleType) {
            titleText += `<br><span style="font-size: 3.5vw; color: #666; font-weight: normal;">车型：${vehicleType}</span>`;
        }

        const historyModalHTML = `
            <div id="busHistoryModal" class="bus-history-modal" data-bus-id="${busId}" style="display: none;">
                <div class="bus-history-content">
                    <div class="bus-history-header">
                        <h2>${titleText}</h2>
                        <span class="bus-history-close">&times;</span>
                    </div>
                    <div class="bus-history-body">
                        <div class="history-actions">
                            <button id="addBusRecord" class="add-btn">添加记录</button>
                            <button id="deleteAllBusRecords" class="danger-btn">删除该车辆所有记录</button>
                        </div>
                        <div class="history-list">
                            ${this.generateHistoryListHTML(history)}
                        </div>
                        <div class="buspedia-link-container">
                            <button id="openCalendarView" class="calendar-btn">出勤日历</button>
                            <button id="openBuspediaDetail" class="buspedia-btn">转到档案站详情</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const historyStyleHTML = `
            <style id="busHistoryModalStyle">
                .bus-history-modal {
                    display: none;
                    position: fixed;
                    z-index: 1002;
                    left: 0;
                    top: 0;
                    width: 100%;
                    height: 100%;
                    background-color: rgba(0,0,0,0.6);
                    opacity: 0;
                    transition: opacity 0.3s ease-out;
                }

                .bus-history-modal.show {
                    opacity: 1;
                }

                .bus-history-content {
                    background-color: #fefefe;
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%) scale(0.7);
                    border: 0.2vw solid #888;
                    width: 70%;
                    max-width: 70vw;
                    max-height: calc(var(--app-vh, 100vh) * 0.7);
                    border-radius: 2vw;
                    overflow: hidden;
                    display: flex;
                    flex-direction: column;
                    opacity: 0;
                    transition: all 0.3s ease-out;
                }

                .bus-history-modal.show .bus-history-content {
                    transform: translate(-50%, -50%) scale(1);
                    opacity: 1;
                }

                .bus-history-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 4vw;
                    background-color: #f5f5f5;
                    border-bottom: 0.2vw solid #ddd;
                }

                .bus-history-header h2 {
                    margin: 0;
                    font-size: 4.5vw;
                    font-family: 'FZH', sans-serif;
                    color: #333;
                    line-height: 1.3;
                }

                .bus-history-close {
                    color: #aaa;
                    font-size: 6vw;
                    font-weight: bold;
                    cursor: pointer;
                }

                .bus-history-close:hover {
                    color: black;
                }

                .bus-history-body {
                    flex: 1;
                    overflow: hidden;
                    display: flex;
                    flex-direction: column;
                    padding: 3vw;
                }

                .history-actions {
                    margin-bottom: 3vw;
                    display: flex;
                    gap: 2vw;
                }

                .add-btn {
                    flex: 1;
                    padding: 2vw 4vw;
                    background-color: #4CAF50;
                    color: white;
                    border: none;
                    border-radius: 1vw;
                    cursor: pointer;
                    font-size: 3.5vw;
                    font-family: 'FZH', sans-serif;
                    transition: background-color 0.3s;
                }

                .add-btn:hover {
                    background-color: #45a049;
                }

                .danger-btn {
                    flex: 1;
                    padding: 2vw 4vw;
                    background-color: #f44336;
                    color: white;
                    border: none;
                    border-radius: 1vw;
                    cursor: pointer;
                    font-size: 3.5vw;
                    font-family: 'FZH', sans-serif;
                    transition: background-color 0.3s;
                }

                .danger-btn:hover {
                    background-color: #da190b;
                }

                .history-list {
                    flex: 1;
                    overflow-y: auto;
                    border: 0.2vw solid #ddd;
                    border-radius: 1vw;
                }

                .buspedia-link-container {
                    margin-top: 2vw;
                    display: flex;
                    gap: 2vw;
                }

                .buspedia-btn,
                .calendar-btn {
                    flex: 1;
                    padding: 1.5vw 3vw;
                    font-size: 3.5vw;
                    border-radius: 1.2vw;
                    border: none;
                    color: #fff;
                    cursor: pointer;
                    box-shadow: 0 0.3vw 0.6vw rgba(0, 0, 0, 0.2);
                    transition: transform 0.1s ease-out, box-shadow 0.1s ease-out, opacity 0.1s ease-out;
                    font-family: 'FZH', sans-serif;
                }

                .calendar-btn {
                    background: linear-gradient(135deg, #4CAF50, #388E3C);
                }

                .buspedia-btn {
                    background: linear-gradient(135deg, #2196F3, #1976D2);
                }

                .buspedia-btn:active,
                .calendar-btn:active {
                    transform: scale(0.96);
                    box-shadow: 0 0.1vw 0.3vw rgba(0, 0, 0, 0.2);
                    opacity: 0.9;
                }

                /* 日历弹窗样式 */
                .bus-calendar-modal {
                    position: fixed;
                    left: 0;
                    top: 0;
                    width: 100%;
                    height: 100%;
                    background-color: rgba(0,0,0,0.5);
                    z-index: 1003;
                    display: none;
                    align-items: center;
                    justify-content: center;
                    opacity: 0;
                    transition: opacity 0.25s ease-out;
                }

                .bus-calendar-content {
                    background-color: #fefefe;
                    width: 90vw;
                    max-width: 90vw;
                    max-height: calc(var(--app-vh, 100vh) * 0.9);
                    border-radius: 2vw;
                    padding: 3vw;
                    box-sizing: border-box;
                    font-family: 'FZH', sans-serif;
                    display: flex;
                    flex-direction: column;
                    box-shadow: 0 0.8vw 2vw rgba(0, 0, 0, 0.25);
                    border: 0.2vw solid #ddd;
                    transform: scale(0.9);
                    transition: transform 0.25s ease-out;
                }

                .bus-calendar-modal.show {
                    display: flex;
                    opacity: 1;
                }

                .bus-calendar-modal.show .bus-calendar-content {
                    transform: scale(1);
                }

                .bus-calendar-header {
                    display: flex;
                    flex-direction: column;
                    align-items: stretch;
                    margin-bottom: 2vw;
                    padding-bottom: 1.5vw;
                    border-bottom: 0.2vw solid #eee;
                }

                .bus-calendar-title {
                    display: flex;
                    flex-direction: column;
                    align-items: flex-start;
                    justify-content: center;
                    gap: 0.6vw;
                    width: 100%;
                    min-width: 0;
                    margin-bottom: 1vw;
                }

                .bus-calendar-title-main {
                    font-size: 4.2vw;
                    font-weight: bold;
                    color: #333;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                .bus-calendar-title-sub {
                    font-size: 3.4vw;
                    color: #666;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                .calendar-date-label {
                    cursor: pointer;
                    color: #1976D2;
                    text-decoration: none;
                }

                .bus-calendar-nav {
                    display: flex;
                    justify-content: flex-end;
                    gap: 1vw;
                    width: 100%;
                    align-items: center;
                    flex-wrap: nowrap; /* 强制单行显示按钮 */
                }

                .bus-calendar-nav button {
                    padding: 0.3vw 1.2vw;
                    font-size: 2.8vw;
                    border-radius: 1vw;
                    border: none;
                    background-color: #f0f0f0;
                    cursor: pointer;
                    font-family: 'FZH', sans-serif;
                    margin-left: 1vw;
                    box-shadow: 0 0.2vw 0.4vw rgba(0,0,0,0.15);
                    transition: background-color 0.2s ease-out, transform 0.1s ease-out, opacity 0.1s ease-out;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 1vw;
                }

                .bus-calendar-nav button img {
                    width: 3.4vw;
                    height: 3.4vw;
                }

                .bus-calendar-nav button:active {
                    transform: scale(0.96);
                    background-color: #e0e0e0;
                    opacity: 0.9;
                }

                .bus-calendar-jump {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.8vw;
                    margin-right: auto;
                    font-size: 3vw;
                    color: #555;
                    font-family: 'FZH', sans-serif;
                }

                .bus-calendar-jump input,
                .bus-calendar-jump select {
                    border: 0.2vw solid #ddd;
                    border-radius: 0.8vw;
                    padding: 0.4vw 0.8vw;
                    font-size: 3vw;
                    font-family: 'FZH', sans-serif;
                    background-color: #fff;
                }

                .bus-calendar-jump input {
                    width: 12vw;
                    text-align: center;
                }

                .bus-calendar-grid {
                    display: grid;
                    grid-template-columns: repeat(7, 1fr);
                    gap: 1vw;
                    font-size: 3vw;
                    margin-bottom: 2vw;
                }

                .bus-calendar-legend {
                    margin-top: 2vw;
                    display: flex;
                    flex-wrap: wrap;
                    gap: 1vw 2vw;
                    font-size: 3vw;
                    align-items: center;
                    border-top: 0.2vw dashed #eee;
                    padding-top: 1.5vw;
                }

                .bus-calendar-legend-item {
                    display: flex;
                    align-items: center;
                    padding: 0.5vw 1vw;
                    border-radius: 1vw;
                    background-color: #fafafa;
                }

                .bus-calendar-legend-color {
                    width: 3vw;
                    height: 3vw;
                    border-radius: 0.6vw;
                    margin-right: 1vw;
                    border: 0.2vw solid rgba(0,0,0,0.1);
                }

                .bus-calendar-weekday {
                    text-align: center;
                    font-weight: bold;
                    padding-bottom: 1vw;
                    color: #666;
                }

                .bus-calendar-day {
                    min-height: 10vw;
                    border-radius: 1vw;
                    background-color: #fff;
                    border: 0.2vw solid #eee;
                    box-sizing: border-box;
                    padding: 0.8vw;
                    display: flex;
                    flex-direction: column;
                    box-shadow: 0 0.2vw 0.4vw rgba(0,0,0,0.05);
                }

                .bus-calendar-day-number {
                    font-size: 3vw;
                    margin-bottom: 0.5vw;
                }

                .bus-calendar-day-bar {
                    display: flex;
                    flex: 1;
                    overflow: hidden;
                    border-radius: 0.8vw;
                }

                .bus-calendar-day-segment {
                    height: 4vw;
                }

                .history-table {
                    width: 100%;
                    border-collapse: collapse;
                    font-family: 'FZH', sans-serif;
                    table-layout: fixed;
                }

                .history-table th:nth-child(1),
                .history-table td:nth-child(1) {
                    width: 25%;
                }

                .history-table th:nth-child(2),
                .history-table td:nth-child(2) {
                    width: 30%;
                }

                .history-table th:nth-child(3),
                .history-table td:nth-child(3) {
                    width: 25%;
                }

                .history-table th:nth-child(4),
                .history-table td:nth-child(4) {
                    width: 20%;
                }

                .history-table th {
                    background-color: #f8f9fa;
                    padding: 2vw;
                    text-align: left;
                    border-bottom: 0.2vw solid #ddd;
                    font-size: 3.2vw;
                    position: sticky;
                    top: 0;
                    z-index: 10;
                }

                .history-table td {
                    padding: 1.8vw 2vw;
                    border-bottom: 0.1vw solid #eee;
                    font-size: 3vw;
                    line-height: 1.2;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                .history-table td:nth-child(4) {
                    white-space: normal;
                    overflow: visible;
                }

                .history-table tr:hover {
                    background-color: #f5f5f5;
                }

                .history-item-actions {
                    display: flex;
                    gap: 1vw;
                    align-items: center;
                    justify-content: center;
                    height: 100%;
                }

                .small-btn {
                    padding: 0.8vw 1.5vw;
                    border: none;
                    border-radius: 0.5vw;
                    cursor: pointer;
                    font-size: 2.5vw;
                    font-family: 'FZH', sans-serif;
                    transition: background-color 0.3s;
                    white-space: nowrap; /* 防止文字换行 */
                }

                .delete-btn {
                    background-color: #ff5722;
                    color: white;
                }

                .delete-btn:hover {
                    background-color: #e64a19;
                }

                /* 删除记录按钮样式 - 简洁文本样式 */
                .delete-record-btn {
                    background: none;
                    border: none;
                    color: #ff5722;
                    cursor: pointer;
                    font-size: 2.8vw;
                    font-family: 'FZH', sans-serif;
                    padding: 0;
                    text-decoration: underline;
                    transition: color 0.2s;
                    line-height: 1.2;
                }

                .delete-record-btn:hover {
                    color: #e64a19;
                }


                /* 分组概览行样式 */
                .history-group-row {
                    background-color: #f8f9fa;
                    font-weight: 500;
                    font-size: 3.8vw;
                }

                /* 可点击行样式 */
                .clickable-row {
                    cursor: pointer;
                    transition: background-color 0.2s ease;
                }

                .clickable-row:hover {
                    background-color: #e3f2fd !important;
                }

                /* 展开指示器样式 */
                .expand-indicator {
                    display: inline-block;
                    margin-right: 1vw;
                    font-size: 3.2vw;
                    color: #2196F3;
                    transition: transform 0.3s ease;
                }

                .expand-indicator.expanded {
                    transform: rotate(90deg);
                }

                /* 记录数量标签 */
                .record-count {
                    color: #666;
                    font-size: 0.9em;
                    font-weight: normal;
                }

                /* 详细记录容器 - 默认隐藏 */
                .group-details-container {
                    background-color: #fafafa;
                    display: none;
                }

                /* 展开状态 */
                .group-details-container.expanded {
                    display: table-row;
                }

                /* 收起动画 */
                .group-details-container.collapsing {
                    display: table-row;
                }

                .group-details-container .details-td {
                    padding: 0;
                    overflow: hidden;
                }

                .group-details-wrapper {
                    padding: 1vw 2vw;
                    background-color: #fafafa;
                    max-height: 0;
                    overflow: hidden;
                    opacity: 0;
                    transform: translateY(-10px);
                    transition: max-height 0.5s ease-out, opacity 0.3s ease-out, transform 0.3s ease-out;
                }

                .group-details-container.expanded .group-details-wrapper {
                    /* max-height 将通过 JavaScript 动态设置为实际内容高度 */
                    opacity: 1;
                    transform: translateY(0);
                }

                .group-details-container.collapsing .group-details-wrapper {
                    max-height: 0 !important;
                    opacity: 0;
                    transform: translateY(-10px);
                }

                /* 详细记录表格 */
                .details-table {
                    width: 100%;
                    border-collapse: collapse;
                    font-family: 'FZH', sans-serif;
                    background-color: white;
                    border: 0.1vw solid #e0e0e0;
                    border-radius: 0.5vw;
                    overflow: hidden;
                }

                .details-table th {
                    background-color: #e3f2fd;
                    padding: 1.8vw 2vw;
                    text-align: left;
                    font-size: 3.5vw;
                    color: #1976D2;
                    border-bottom: 0.2vw solid #90caf9;
                }

                .details-table td {
                    padding: 1.8vw 2vw;
                    border-bottom: 0.1vw solid #eee;
                    font-size: 3.5vw;
                    line-height: 1.2;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                .details-table tr:last-child td {
                    border-bottom: none;
                }

                .detail-record-row:hover {
                    background-color: #f5f5f5;
                }

                /* 详细表格操作列样式 */
                .details-table td:last-child {
                    text-align: center;
                }

                .details-table th:last-child {
                    text-align: center;
                }

                .empty-history {
                    text-align: center;
                    padding: 5vw;
                    color: #666;
                    font-size: 3.5vw;
                    font-family: 'FZH', sans-serif;
                }

                @media (max-width: 768px) {
                    .bus-history-content {
                        width: 90%;
                        max-width: 90vw;
                        margin: 5% auto;
                    }

                    .bus-history-header h2 {
                        font-size: 4vw;
                    }

                    .history-table th {
                        font-size: 2.8vw;
                        padding: 1.5vw 1vw;
                    }

                    .history-table td {
                        font-size: 2.5vw;
                        padding: 1.2vw 1vw;
                        line-height: 1.2;
                    }

                    .details-table th {
                        font-size: 2.8vw;
                        padding: 1.5vw 1vw;
                    }

                    .details-table td {
                        font-size: 2.5vw;
                        padding: 1.2vw 1vw;
                        line-height: 1.2;
                    }

                    .history-table th:nth-child(2),
                    .history-table td:nth-child(2) {
                        width: 35%;
                    }

                    .history-table th:nth-child(3),
                    .history-table td:nth-child(3) {
                        width: 30%;
                    }

                    .add-btn {
                        font-size: 3vw;
                        padding: 1.5vw 3vw;
                    }

                    .danger-btn {
                        font-size: 3vw;
                        padding: 1.5vw 3vw;
                    }

                    .small-btn {
                        font-size: 2.2vw;
                        padding: 0.6vw 1.2vw;
                    }
                }
            </style>
        `;

        // 添加样式（如果不存在）
        if (!document.getElementById('busHistoryModalStyle')) {
            document.head.insertAdjacentHTML('beforeend', historyStyleHTML);
        }

        // 添加模态窗口
        document.body.insertAdjacentHTML('beforeend', historyModalHTML);

        // 绑定事件
        this.bindHistoryModalEvents(busId, history, vehicleType);

        // 显示模态窗口
        const modal = document.getElementById('busHistoryModal');
        modal.style.display = 'block';
        modal.offsetHeight; // 强制重排
        modal.classList.add('show');
    }

    // 将历史记录按线路名称分组（仅用于展示）
    // 新规则（取消模糊合并与周期性判断）：
    // 1. 不再做“相似线路”合并，完全按 record.lineName 精确分组
    // 2. 不再按连续性或周期性拆分，同一线路的所有记录都放在同一组/同一列下
    groupRecordsByLine(history) {
        if (history.length === 0) {
            return [];
        }

        // 按日期和时间排序（从新到旧），方便后面计算开行/停班时间
        const sortedHistory = [...history].sort((a, b) => {
            const dateTimeA = new Date(a.date + ' ' + (a.time || '00:00:00'));
            const dateTimeB = new Date(b.date + ' ' + (b.time || '00:00:00'));
            return dateTimeB - dateTimeA; // 从新到旧
        });

        // 按精确线路名称分组：
        // key 为 record.lineName（为空时使用 "未知线路"）
        const groupMap = {}; // lineName -> group

        sortedHistory.forEach(record => {
            const key = record.lineName && record.lineName.trim()
                ? record.lineName.trim()
                : '未知线路';

            if (!groupMap[key]) {
                groupMap[key] = {
                    lineName: key,
                    lineId: record.lineId,
                    records: [],
                    startTime: null,
                    endTime: null,
                    isExpanded: false
                };
            }
            groupMap[key].records.push(record);
        });

        // 将分组结果转为数组
        const groups = Object.values(groupMap);

        // 可选：按组内最新记录时间从近到远排序，最近跑过的线路排在前面
        groups.sort((a, b) => {
            const newestA = a.records[0];
            const newestB = b.records[0];
            const dateTimeA = new Date(newestA.date + ' ' + (newestA.time || '00:00:00'));
            const dateTimeB = new Date(newestB.date + ' ' + (newestB.time || '00:00:00'));
            return dateTimeB - dateTimeA;
        });

        // 计算每组的开始和结束时间
        groups.forEach(group => {
            // 因为每个 group.records 都按 sortedHistory 的顺序添加：
            // 第一条是最新的，最后一条是最旧的
            const newestRecord = group.records[0];
            const oldestRecord = group.records[group.records.length - 1];
            
            // 获取显示时间
            const getDisplayTime = (record) => {
                if (record.recordTime) return record.recordTime;
                if (record.timestamp) {
                    return new Date(record.timestamp).toLocaleString('zh-CN', {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit'
                    });
                }
                return record.date;
            };

            // 开行时间显示最早的记录，停运时间显示最新的记录
            group.startTime = getDisplayTime(oldestRecord);
            group.endTime = getDisplayTime(newestRecord);
        });

        return groups;
    }

    // 创建相似线路分组映射
    // 例如：B12、B12区 → "B12/B12区"，B1、B1K → "B1/B1K"
    createSimilarLineGroups(history) {
        const uniqueLines = [...new Set(history.map(r => r.lineName))];
        const lineGroupMap = {}; // lineName -> groupName
        const processedLines = new Set();

        uniqueLines.forEach(line => {
            if (processedLines.has(line)) return;

            // 查找与当前线路相似的所有线路
            const similarLines = [line];
            
            uniqueLines.forEach(otherLine => {
                if (line !== otherLine && !processedLines.has(otherLine)) {
                    if (this.areSimilarLines(line, otherLine)) {
                        similarLines.push(otherLine);
                    }
                }
            });

            // 如果找到相似线路，使用组合名称
            if (similarLines.length > 1) {
                // 按线路名称排序，确保组名一致
                similarLines.sort();
                const groupName = similarLines.join('/');
                
                similarLines.forEach(l => {
                    lineGroupMap[l] = groupName;
                    processedLines.add(l);
                });
            } else {
                // 没有相似线路，使用原始名称
                lineGroupMap[line] = line;
                processedLines.add(line);
            }
        });

        return lineGroupMap;
    }

    // 判断两条线路是否相似
    // 例如：B12 和 B12区、B1 和 B1K、133路 和 133区间
    areSimilarLines(line1, line2) {
        // 去除常见后缀，提取基础线路号
        const normalize = (line) => {
            return line
                .replace(/[区间线路]/g, '')  // 去除"区"、"间"、"线"、"路"
                .replace(/[支干主副]/g, '')  // 去除"支"、"干"、"主"、"副"
                .replace(/[KkTt]$/i, '')      // 去除尾部的K、T
                .trim();
        };

        const base1 = normalize(line1);
        const base2 = normalize(line2);

        // 如果基础名称相同，认为是相似线路
        if (base1 === base2 && base1.length > 0) {
            return true;
        }

        // 特殊情况：一个是另一个的前缀（如 "1主线" 和 "1支线"）
        // 但要确保基础部分相同
        const getNumberPart = (line) => line.match(/^[\dA-Z]+/i)?.[0] || '';
        const num1 = getNumberPart(line1);
        const num2 = getNumberPart(line2);
        
        if (num1 && num2 && num1 === num2) {
            return true;
        }

        return false;
    }

    // 检测是否存在周期性模式
    // 如果多条不同线路组交替出现，且每条线路组出现次数都比较多，则认为是周期性模式
    detectCyclicPattern(sortedHistory, lineGroupMap) {
        if (sortedHistory.length < 6) {
            // 记录太少，无法判断周期性
            return false;
        }

        // 统计每条线路组的出现次数（使用合并后的线路组）
        const lineCount = {};
        sortedHistory.forEach(record => {
            const groupKey = lineGroupMap[record.lineName];
            lineCount[groupKey] = (lineCount[groupKey] || 0) + 1;
        });

        const uniqueLines = Object.keys(lineCount);
        
        // 如果只有一条线路组，不是周期性
        if (uniqueLines.length === 1) {
            return false;
        }

        // 如果有2-4条不同的线路组
        if (uniqueLines.length >= 2 && uniqueLines.length <= 4) {
            // 计算线路组切换的次数
            let switchCount = 0;
            for (let i = 1; i < sortedHistory.length; i++) {
                const currentGroup = lineGroupMap[sortedHistory[i].lineName];
                const prevGroup = lineGroupMap[sortedHistory[i - 1].lineName];
                if (currentGroup !== prevGroup) {
                    switchCount++;
                }
            }

            // 如果切换次数大于记录数的30%，认为是频繁切换，即周期性模式
            // 例如：A-B-A-B-A-B 有6条记录，切换5次，5/6=83% > 30%
            const switchRatio = switchCount / sortedHistory.length;
            
            // 同时要求每条线路组至少出现3次
            const minOccurrence = Math.min(...Object.values(lineCount));
            
            return switchRatio > 0.3 && minOccurrence >= 3;
        }

        // 线路种类太多（>4），不太可能是固定周期
        return false;
    }

    generateHistoryListHTML(history) {
        if (history.length === 0) {
            return '<div class="empty-history">该车辆暂无运营记录</div>';
        }

        // 分组显示
        const groups = this.groupRecordsByLine(history);

        let html = `
            <table class="history-table">
                <thead>
                    <tr>
                        <th style="width: 35%;">开行时间</th>
                        <th style="width: 30%;">停班时间</th>
                        <th style="width: 35%;">线路名称</th>
                    </tr>
                </thead>
                <tbody>
        `;

        groups.forEach((group, groupIndex) => {
            // 渲染分组概览行 - 整行可点击
            html += `
                <tr class="history-group-row clickable-row" data-group-index="${groupIndex}">
                    <td>
                        <span class="expand-indicator">▶</span>
                        ${group.startTime}
                    </td>
                    <td>${group.endTime}</td>
                    <td>${group.lineName} <span class="record-count">(${group.records.length}条)</span></td>
                </tr>
            `;

            // 渲染该组的详细记录（默认隐藏）
            html += `<tr class="group-details-container" data-group-index="${groupIndex}">
                <td colspan="3" class="details-td">
                    <div class="group-details-wrapper">
                        <table class="details-table">
                            <thead>
                                <tr>
                                    <th style="width: 20%;">日期</th>
                                    <th style="width: 35%;">记录时间</th>
                                    <th style="width: 35%;">线路名称</th>
                                    <th style="width: 10%;">操作</th>
                                </tr>
                            </thead>
                            <tbody>
            `;

            group.records.forEach(record => {
                // 兼容旧记录，如果没有recordTime则从timestamp生成
                let displayTime = record.recordTime;
                if (!displayTime && record.timestamp) {
                    displayTime = new Date(record.timestamp).toLocaleString('zh-CN', {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit'
                    });
                } else if (!displayTime) {
                    displayTime = '未知';
                }

                html += `
                    <tr class="detail-record-row">
                        <td>${record.date}</td>
                        <td>${displayTime}</td>
                        <td>${record.lineName}</td>
                        <td>
                            <div class="history-item-actions">
                                <button class="delete-record-btn" data-record-id="${record.id}">删除</button>
                            </div>
                        </td>
                    </tr>
                `;
            });

            html += `
                            </tbody>
                        </table>
                    </div>
                </td>
            </tr>
            `;
        });

        html += `
                </tbody>
            </table>
        `;

        return html;
    }

    // 显示指定车辆的出勤日历
    showBusCalendar(busId) {
        const history = busRecordsManager.getBusHistory(busId);
        if (!history || history.length === 0) {
            this.showCustomAlert('提示', '该车辆暂无运营记录，无法生成日历。');
            return;
        }

        // 构建 日期 -> 线路集合 映射
        const dateLinesMap = {};
        history.forEach(record => {
            if (!record.date || !record.lineName) return;
            if (!dateLinesMap[record.date]) {
                dateLinesMap[record.date] = new Set();
            }
            dateLinesMap[record.date].add(record.lineName);
        });

        // 构建 线路 -> 颜色 映射（同一线路同一颜色）
        const colorPalette = [
            '#4CAF50', '#F44336', '#FF9800', '#2196F3', '#9C27B0',
            '#00BCD4', '#8BC34A', '#FF5722', '#3F51B5', '#795548'
        ];
        const lineColorMap = {};
        let colorIndex = 0;
        Object.keys(dateLinesMap).forEach(date => {
            dateLinesMap[date].forEach(line => {
                if (!lineColorMap[line]) {
                    lineColorMap[line] = colorPalette[colorIndex % colorPalette.length];
                    colorIndex++;
                }
            });
        });

        // 默认显示最新记录所在月份
        const newest = history[0];
        let [year, month] = newest.date.split('-').map(n => parseInt(n, 10));
        if (!year || !month) {
            const now = new Date();
            year = now.getFullYear();
            month = now.getMonth() + 1;
        }

        this.openCalendarModal(busId, year, month, dateLinesMap, lineColorMap);
    }

    // 打开/创建日历窗口
    openCalendarModal(busId, year, month, dateLinesMap, lineColorMap) {
        let modal = document.getElementById('busCalendarModal');
        if (!modal) {
            const html = `
                <div id="busCalendarModal" class="bus-calendar-modal" data-year="${year}" data-month="${month}" data-bus-id="${busId}">
                    <div class="bus-calendar-content">
                        <div class="bus-calendar-header">
                            <div class="bus-calendar-title">
                                <span class="bus-calendar-title-main"></span>
                                <span class="bus-calendar-title-sub"></span>
                            </div>
                            <div class="bus-calendar-nav">
                                <button id="calendarPrevMonth">
                                    <img src="./index_files/fanxiang.png" style="transform: rotate(180deg);" alt="prev">
                                    <span>上一月</span>
                                </button>
                                <button id="calendarNextMonth">
                                    <img src="./index_files/fanxiang.png" alt="next">
                                    <span>下一月</span>
                                </button>
                                <button id="calendarClose">
                                    <img src="./index_files/close.png" alt="close">
                                    <span>关闭</span>
                                </button>
                            </div>
                        </div>
                        <div class="bus-calendar-grid" id="busCalendarGrid"></div>
                        <div class="bus-calendar-legend" id="busCalendarLegend"></div>
                    </div>
                </div>
            `;
            document.body.insertAdjacentHTML('beforeend', html);
            modal = document.getElementById('busCalendarModal');

            // 关闭按钮
            const closeBtn = document.getElementById('calendarClose');
            closeBtn.addEventListener('click', () => {
                this.closeCalendarModal();
            });

            // 点击遮罩关闭：只有点在背景上才关闭
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this.closeCalendarModal();
                }
            });

            // 月份切换
            document.getElementById('calendarPrevMonth').addEventListener('click', () => {
                this.shiftCalendarMonth(-1, dateLinesMap, lineColorMap);
            });
            document.getElementById('calendarNextMonth').addEventListener('click', () => {
                this.shiftCalendarMonth(1, dateLinesMap, lineColorMap);
            });
        } else {
            modal.dataset.year = year;
            modal.dataset.month = month;
            modal.dataset.busId = busId;
        }

        // 显示并播放弹出动画
        modal.style.display = 'flex';
        // 强制重排再加 show 类，触发过渡
        modal.offsetHeight;
        modal.classList.add('show');

        this.renderCalendar(busId, dateLinesMap, lineColorMap);
    }

    // 关闭日历窗口（带关闭动画）
    closeCalendarModal() {
        const modal = document.getElementById('busCalendarModal');
        if (!modal) return;

        modal.classList.remove('show');
        // 等待过渡结束再移除
        setTimeout(() => {
            const m = document.getElementById('busCalendarModal');
            if (m && m.parentNode) {
                m.parentNode.removeChild(m);
            }
        }, 250);
    }

    // 切换月份
    shiftCalendarMonth(delta, dateLinesMap, lineColorMap) {
        const modal = document.getElementById('busCalendarModal');
        if (!modal) return;
        let year = parseInt(modal.dataset.year, 10);
        let month = parseInt(modal.dataset.month, 10);
        month += delta;
        if (month < 1) {
            month = 12;
            year -= 1;
        } else if (month > 12) {
            month = 1;
            year += 1;
        }
        modal.dataset.year = String(year);
        modal.dataset.month = String(month);
        this.renderCalendar(modal.dataset.busId, dateLinesMap, lineColorMap);
    }

    // 渲染日历内容
    renderCalendar(busId, dateLinesMap, lineColorMap) {
        const modal = document.getElementById('busCalendarModal');
        if (!modal) return;

        const year = parseInt(modal.dataset.year, 10);
        const month = parseInt(modal.dataset.month, 10);

        const titleMainEl = modal.querySelector('.bus-calendar-title-main');
        const titleSubEl = modal.querySelector('.bus-calendar-title-sub');
        if (titleMainEl) {
            // 日期部分包一层 span，点击可修改年月
            const monthStr = month.toString().padStart(2, '0');
            titleMainEl.innerHTML = `
                <span id="calendarDateLabel" class="calendar-date-label">${year}年${monthStr}月</span>
                出勤情况
            `;
        }
        if (titleSubEl) {
            titleSubEl.textContent = busId || '';
        }

        // 绑定点击日期标签修改年月
        const dateLabel = modal.querySelector('#calendarDateLabel');
        if (dateLabel) {
            dateLabel.onclick = () => {
                try {
                    const currentYear = year;
                    const currentMonth = month;
                    const defaultValue = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;
                    const input = prompt('请输入要跳转的年月（格式：YYYY-MM，例如 2025-05）', defaultValue);
                    if (!input) return;

                    const match = input.trim().match(/^(\d{4})[^\d]?(\d{1,2})$/) || input.trim().match(/^(\d{4})-(\d{1,2})$/);
                    if (!match) {
                        alert('格式不正确，请输入类似 2025-05 的年月');
                        return;
                    }
                    const newYear = parseInt(match[1], 10);
                    const newMonth = parseInt(match[2], 10);
                    if (!newYear || !newMonth || newMonth < 1 || newMonth > 12) {
                        alert('请输入有效的年份和 1-12 之间的月份');
                        return;
                    }

                    modal.dataset.year = String(newYear);
                    modal.dataset.month = String(newMonth);
                    this.renderCalendar(busId, dateLinesMap, lineColorMap);
                } catch (e) {
                    console.error('修改日历年月失败:', e);
                }
            };
        }

        const grid = document.getElementById('busCalendarGrid');
        if (!grid) return;

        // 计算当月信息
        const firstDay = new Date(year, month - 1, 1);
        const startWeekday = firstDay.getDay() || 7; // 周日当作7
        const daysInMonth = new Date(year, month, 0).getDate();

        const weekdays = ['一', '二', '三', '四', '五', '六', '日'];

        let html = '';

        // 星期标题
        weekdays.forEach(w => {
            html += `<div class="bus-calendar-weekday">周${w}</div>`;
        });

        // 前置空白
        for (let i = 1; i < startWeekday; i++) {
            html += `<div></div>`;
        }

        // 每一天
        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const linesSet = dateLinesMap[dateStr];
            let segmentsHtml = '';

            if (linesSet && linesSet.size > 0) {
                const lines = Array.from(linesSet);
                const segWidth = 100 / lines.length;
                segmentsHtml = lines.map(line => {
                    const color = lineColorMap[line] || '#ccc';
                    return `<div class="bus-calendar-day-segment" style="width:${segWidth}%;background-color:${color};" title="${line}"></div>`;
                }).join('');
            }

            html += `
                <div class="bus-calendar-day">
                    <div class="bus-calendar-day-number">${day}</div>
                    <div class="bus-calendar-day-bar">
                        ${segmentsHtml}
                    </div>
                </div>
            `;
        }

        grid.innerHTML = html;

        // 渲染图例：显示每条线路对应的颜色
        const legend = document.getElementById('busCalendarLegend');
        if (legend) {
            let legendHtml = '';
            const lines = Object.keys(lineColorMap);
            lines.forEach(line => {
                const color = lineColorMap[line];
                legendHtml += `
                    <div class="bus-calendar-legend-item">
                        <div class="bus-calendar-legend-color" style="background-color:${color};"></div>
                        <span>${this.escapeHtml(line)}</span>
                    </div>
                `;
            });
            legend.innerHTML = legendHtml;
        }
    }

    // HTML转义函数
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    bindHistoryModalEvents(busId, history, vehicleType = null) {
        const modal = document.getElementById('busHistoryModal');
        const closeBtn = document.querySelector('.bus-history-close');
        const addBtn = document.getElementById('addBusRecord');
        const deleteAllBtn = document.getElementById('deleteAllBusRecords');
        const buspediaBtn = document.getElementById('openBuspediaDetail');
        const calendarBtn = document.getElementById('openCalendarView');

        // 关闭按钮
        closeBtn.addEventListener('click', () => this.closeBusHistoryModal());

        // 点击背景关闭
        modal.addEventListener('click', (e) => {
            if (e.target === modal) this.closeBusHistoryModal();
        });

        // 添加记录按钮
        addBtn.addEventListener('click', () => {
            this.showAddRecordForBus(busId);
        });

        // 删除所有记录按钮
        deleteAllBtn.addEventListener('click', async () => {
            const confirmed = await this.showCustomConfirm(
                '删除车辆记录确认',
                `确定要删除车辆 ${busId} 的所有运营记录吗？\n此操作无法撤销！`,
                '删除',
                '取消',
                true
            );
            
            if (confirmed) {
                await this.deleteAllBusRecords(busId);
            }
        });

        // 档案站详情按钮
        if (buspediaBtn) {
            buspediaBtn.addEventListener('click', () => {
                try {
                    const currentBusId = modal.getAttribute('data-bus-id') || busId || '';
                    if (!currentBusId) {
                        console.warn('未获取到车牌号，无法打开档案站详情');
                        return;
                    }

                    // 按规则构造 name 参数：
                    // 普通： "苏G28130D"  -> "苏G 28130D"
                    // 公交牌： "苏GA9389" -> "苏G A 9389"
                    let nameParam = currentBusId;

                    // 1. 先尝试匹配带两位字母的公交牌（如 "苏GA9389"）
                    const gaMatch = currentBusId.match(/^([\u4e00-\u9fa5])([A-Z])([A-Z])(\d.*)$/);
                    if (gaMatch) {
                        const province = gaMatch[1];   // 苏
                        const cityLetter = gaMatch[2]; // G
                        const typeLetter = gaMatch[3]; // A
                        const numberPart = gaMatch[4]; // 9389...
                        // 期望格式：苏G A9389（城市后有空格，类型字母与数字连在一起）
                        nameParam = `${province}${cityLetter} ${typeLetter}${numberPart}`;
                    } else {
                        // 2. 其它情况：按第一个数字拆分为“前缀 + 数字部分”
                        const firstDigitIndex = currentBusId.search(/\d/);
                        let provinceCity = currentBusId;
                        let numberPart = '';

                        if (firstDigitIndex > 0) {
                            provinceCity = currentBusId.slice(0, firstDigitIndex);
                            numberPart = currentBusId.slice(firstDigitIndex);
                        }

                        nameParam = provinceCity + (numberPart ? (' ' + numberPart) : '');
                    }

                    // 随后整体进行 URL 编码
                    const url = `https://buspedia.top/search?name=${encodeURIComponent(nameParam)}`;

                    if (typeof window.openInSidebar === 'function') {
                        window.openInSidebar(url);
                    } else {
                        window.open(url, '_blank');
                    }
                } catch (e) {
                    console.error('打开档案站详情失败:', e);
                }
            });
        }

        // 查看日历按钮
        if (calendarBtn) {
            calendarBtn.addEventListener('click', () => {
                this.showBusCalendar(busId);
            });
        }

        // 绑定历史记录项的事件（包括删除按钮）
        this.bindHistoryItemEvents(busId, history);
    }

    closeBusHistoryModal() {
        const modal = document.getElementById('busHistoryModal');
        if (modal) {
            // 清理事件监听器
            const historyBody = modal.querySelector('.bus-history-body');
            if (historyBody && historyBody._clickHandler) {
                historyBody.removeEventListener('click', historyBody._clickHandler);
                historyBody._clickHandler = null;
            }
            
            modal.classList.remove('show');
            setTimeout(() => {
                if (modal && modal.parentNode) {
                    document.body.removeChild(modal);
                }
            }, 300);
        }
    }

    async deleteHistoryRecord(recordId) {
        // 先获取当前车辆ID，因为删除后可能需要重新打开
        const currentBusId = this.getCurrentBusIdFromModal();
        
        const confirmed = await this.showCustomConfirm(
            '删除记录确认',
            '确定要删除这条记录吗？',
            '删除',
            '取消',
            true
        );
        
        if (confirmed) {
            const success = await busRecordsManager.deleteRecord(recordId);
            if (success) {
                // 关闭当前的历史记录窗口
                this.closeBusHistoryModal();
                
                // 清除缓存
                this.clearCache();
                
                // 刷新主窗口显示
                this.updateStatistics();
                this.loadRecords();
                
                // 如果有车辆ID，重新打开该车辆的历史记录
                if (currentBusId) {
                    // 使用 setTimeout 确保关闭动画完成后再打开
                    // 此时 busRecordsManager.records 已经是删除后的最新数据
                    setTimeout(() => {
                        console.log('重新打开车辆历史:', currentBusId);
                        const history = busRecordsManager.getBusHistory(currentBusId);
                        console.log('获取到的历史记录数量:', history.length);
                        this.showBusHistory(currentBusId);
                    }, 100);
                }
            } else {
                await this.showCustomAlert('删除失败', '无法删除该记录，请稍后重试。');
            }
        }
    }

    // 从模态窗口中获取当前车牌号
    getCurrentBusIdFromModal() {
        const modal = document.getElementById('busHistoryModal');
        if (modal) {
            // 直接从 data-bus-id 属性获取车牌号，更可靠
            return modal.getAttribute('data-bus-id');
        }
        return null;
    }

    // 重新绑定历史记录项的事件
    bindHistoryItemEvents(busId, history) {
        // 使用事件委托绑定删除按钮事件
        // 注意：这里监听的是 .bus-history-body，而不是 .history-list
        // 因为 .history-list 的 innerHTML 会被更新，导致事件丢失
        const historyBody = document.querySelector('.bus-history-body');
        if (historyBody) {
            // 移除旧的事件监听器（如果存在）
            if (historyBody._clickHandler) {
                historyBody.removeEventListener('click', historyBody._clickHandler);
            }
            
            // 创建新的事件处理器
            const clickHandler = (e) => {
                // 删除单条记录
                if (e.target.classList.contains('delete-record-btn')) {
                    e.stopPropagation();
                    const recordId = e.target.getAttribute('data-record-id');
                    this.deleteHistoryRecord(recordId);
                    return;
                }
                
                // 点击概览行展开/收起
                const groupRow = e.target.closest('.clickable-row');
                if (groupRow) {
                    const groupIndex = groupRow.getAttribute('data-group-index');
                    this.toggleGroup(groupIndex);
                }
            };
            
            // 保存处理器引用并绑定事件
            historyBody._clickHandler = clickHandler;
            historyBody.addEventListener('click', clickHandler);
        }
    }

    // 展开/收起分组（带动画）
    toggleGroup(groupIndex) {
        const detailsContainer = document.querySelector(`.group-details-container[data-group-index="${groupIndex}"]`);
        const groupRow = document.querySelector(`.clickable-row[data-group-index="${groupIndex}"]`);
        const indicator = groupRow ? groupRow.querySelector('.expand-indicator') : null;
        
        if (!detailsContainer) return;
        
        const wrapper = detailsContainer.querySelector('.group-details-wrapper');
        if (!wrapper) return;
        
        const isExpanded = detailsContainer.classList.contains('expanded');
        
        if (isExpanded) {
            // 收起 - 先设置当前高度，然后在下一帧设置为0触发动画
            const currentHeight = wrapper.scrollHeight;
            wrapper.style.maxHeight = currentHeight + 'px';
            
            // 强制重排
            wrapper.offsetHeight;
            
            // 移除 expanded 类并添加 collapsing 类
            detailsContainer.classList.remove('expanded');
            detailsContainer.classList.add('collapsing');
            if (indicator) {
                indicator.classList.remove('expanded');
            }
            
            // 在下一帧将高度设置为0
            requestAnimationFrame(() => {
                wrapper.style.maxHeight = '0px';
            });
            
            // 等待动画完成后完全隐藏
            setTimeout(() => {
                detailsContainer.classList.remove('collapsing');
                detailsContainer.style.display = 'none'; // 完全隐藏，避免占据空间
                wrapper.style.maxHeight = ''; // 清除内联样式
            }, 500); // 与CSS动画时间一致（增加到0.5s）
        } else {
            // 展开 - 先显示但不展开，然后计算实际高度并触发展开动画
            detailsContainer.style.display = 'table-row';
            
            // 强制重排，让浏览器应用初始的 max-height: 0 状态
            detailsContainer.offsetHeight;
            
            // 获取wrapper的实际内容高度
            const targetHeight = wrapper.scrollHeight;
            
            // 在下一帧添加 expanded 类并设置目标高度
            requestAnimationFrame(() => {
                detailsContainer.classList.add('expanded');
                wrapper.style.maxHeight = targetHeight + 'px';
                if (indicator) {
                    indicator.classList.add('expanded');
                }
            });
            
            // 动画完成后清除固定高度，改为auto，以适应内容变化
            setTimeout(() => {
                if (detailsContainer.classList.contains('expanded')) {
                    wrapper.style.maxHeight = 'none';
                }
            }, 500);
        }
    }


    async deleteAllBusRecords(busId) {
        // 找到该车辆的所有记录
        const recordsToDelete = busRecordsManager.records.filter(record => record.busId === busId);
        
        if (recordsToDelete.length === 0) {
            await this.showCustomAlert('提示', '该车辆没有记录可删除');
            return;
        }

        // 删除所有相关记录，逐条等待删除完成以确保持久化
        let deletedCount = 0;
        for (const record of recordsToDelete) {
            try {
                const ok = await busRecordsManager.deleteRecord(record.id);
                if (ok) deletedCount++;
            } catch (e) {
                console.error('删除记录时出错:', record.id, e);
            }
        }

        // 清除缓存
        this.clearCache();

        // 刷新主窗口显示
        this.updateStatistics();
        this.loadRecords();
        
        // 刷新详情窗口显示空状态，而不是关闭窗口
        const historyList = document.querySelector('.history-list');
        if (historyList) {
            historyList.innerHTML = `
                <div class="empty-state" style="text-align: center; padding: 2rem; color: #666;">
                    <div style="font-size: 3rem; margin-bottom: 1rem;">📭</div>
                    <div style="font-size: 1.2rem; margin-bottom: 0.5rem;">暂无运营记录</div>
                    <div style="font-size: 0.9rem;">该车辆的所有记录已被删除</div>
                </div>
            `;
        }
    }

    async cleanOldRecords() {
        // 计算30天前的日期
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - 30);
        const cutoffString = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, '0')}-${String(cutoffDate.getDate()).padStart(2, '0')}`;
        
        // 统计30天前的记录数量
        const oldCount = busRecordsManager.records.filter(record => record.date < cutoffString).length;
        
        if (oldCount === 0) {
            await this.showCustomAlert('无数据', '没有找到30天前的记录');
            return;
        }
        
        const confirmed = await this.showCustomConfirm(
            '清理旧数据确认',
            `确定要清理30天前（${cutoffString}之前）的记录吗？\n\n将删除 ${oldCount} 条旧记录，此操作无法撤销！`,
            '确定清理',
            '取消',
            true
        );
        
        if (confirmed) {
            const originalLength = busRecordsManager.records.length;
            const deletedCount = await busRecordsManager.cleanOldRecords(30);
            
            // 清除缓存
            this.clearCache();
            
            this.updateStatistics();
            this.loadRecords();
            await this.showCustomAlert('清理成功', `成功清理30天前的记录，共删除了 ${deletedCount} 条记录`);
        }
    }

    async clearTodayRecords() {
        // 获取今日日期
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        
        // 统计今日记录数量
        const todayCount = busRecordsManager.records.filter(record => record.date === today).length;
        
        if (todayCount === 0) {
            await this.showCustomAlert('无数据', '今日暂无记录数据');
            return;
        }
        
        const confirmed = await this.showCustomConfirm(
            '清空今日数据确认',
            `确定要清空今日（${today}）的记录吗？\n\n将删除 ${todayCount} 条今日记录，此操作无法撤销！`,
            '确定清空',
            '取消',
            true
        );
        
            if (confirmed) {
                const result = await busRecordsManager.clearTodayRecords();
                if (result.success) {
                    // 清除缓存
                    this.clearCache();
                    
                    this.updateStatistics();
                    this.loadRecords();
                    await this.showCustomAlert('清空成功', `成功清空今日记录，共删除了 ${result.deletedCount} 条记录`);
                } else {
                    await this.showCustomAlert('清空失败', '无法清空今日记录，请稍后重试。');
                }
            }
    }

    async clearAllRecords() {
        const firstConfirm = await this.showCustomConfirm(
            '清空记录确认',
            '确定要清空所有记录吗？此操作无法撤销！',
            '继续',
            '取消'
        );
        
        if (firstConfirm) {
            const secondConfirm = await this.showCustomConfirm(
                '最终确认',
                '请再次确认：您确定要永久删除所有车牌记录吗？\n\n此操作将删除所有车牌运营记录，且无法恢复！',
                '确定删除',
                '取消',
                true
            );
            
            if (secondConfirm) {
                const success = await busRecordsManager.clearAllRecords();
                if (success) {
                    // 清除缓存
                    this.clearCache();
                    
                    this.updateStatistics();
                    this.loadRecords();
                } else {
                    await this.showCustomAlert('清空失败', '无法清空记录，请稍后重试。');
                }
            }
        }
    }

    // 自定义提示对话框
    showCustomAlert(title, message, buttonText = '确定') {
        return new Promise((resolve) => {
            // 生成唯一ID
            const overlayId = 'customAlertOverlay_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            const okBtnId = 'customAlertOk_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            
            // 清理已存在的提示对话框
            const existingOverlays = document.querySelectorAll('.custom-alert-overlay');
            existingOverlays.forEach(overlay => {
                if (overlay && overlay.parentNode) {
                    overlay.parentNode.removeChild(overlay);
                }
            });
            
            // 创建模态窗口HTML
            const modalHTML = `
                <div id="${overlayId}" class="custom-alert-overlay">
                    <div class="custom-alert-content">
                        <div class="custom-alert-header">
                            <h3>${title}</h3>
                        </div>
                        <div class="custom-alert-body">
                            <p>${message.replace(/\n/g, '<br>')}</p>
                        </div>
                        <div class="custom-alert-footer">
                            <button id="${okBtnId}" class="custom-alert-btn">${buttonText}</button>
                        </div>
                    </div>
                </div>
                <style>
                    .custom-alert-overlay {
                        position: fixed;
                        top: 0;
                        left: 0;
                        width: 100%;
                        height: 100%;
                        background-color: rgba(0, 0, 0, 0.6);
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        z-index: 10000;
                        backdrop-filter: blur(2px);
                    }

                    .custom-alert-content {
                        background: white;
                        border-radius: 12px;
                        max-width: 90vw;
                        width: 400px;
                        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
                        overflow: hidden;
                        animation: fadeInScale 0.3s ease-out;
                    }

                    @keyframes fadeInScale {
                        from {
                            opacity: 0;
                            transform: scale(0.8);
                        }
                        to {
                            opacity: 1;
                            transform: scale(1);
                        }
                    }

                    .custom-alert-header {
                        background: #f8f9fa;
                        border-bottom: 1px solid #e9ecef;
                        padding: 20px 24px 16px;
                    }

                    .custom-alert-header h3 {
                        margin: 0;
                        font-size: 1.2rem;
                        font-weight: 600;
                        color: #2c3e50;
                    }

                    .custom-alert-body {
                        padding: 24px;
                        line-height: 1.6;
                        color: #495057;
                        font-size: 0.95rem;
                    }

                    .custom-alert-body p {
                        margin: 0;
                    }

                    .custom-alert-footer {
                        background: #f8f9fa;
                        border-top: 1px solid #e9ecef;
                        padding: 16px 24px;
                        display: flex;
                        justify-content: flex-end;
                    }

                    .custom-alert-btn {
                        padding: 8px 24px;
                        border: none;
                        border-radius: 6px;
                        font-size: 0.9rem;
                        font-weight: 500;
                        cursor: pointer;
                        transition: all 0.1s ease-out;
                        background-color: #2196F3;
                        color: white;
                        min-width: 80px;
                    }

                    .custom-alert-btn:active {
                        background-color: #1976D2;
                        transform: scale(0.95);
                    }

                    @media (max-width: 768px) {
                        .custom-alert-content {
                            width: 85vw;
                            margin: 0 20px;
                        }

                        .custom-alert-header {
                            padding: 16px 20px 12px;
                        }

                        .custom-alert-header h3 {
                            font-size: 1.1rem;
                        }

                        .custom-alert-body {
                            padding: 20px;
                            font-size: 0.9rem;
                        }

                        .custom-alert-footer {
                            padding: 12px 20px;
                        }

                        .custom-alert-btn {
                            padding: 10px 20px;
                            font-size: 0.85rem;
                        }
                    }
                </style>
            `;

            // 添加到页面
            document.body.insertAdjacentHTML('beforeend', modalHTML);

            const overlay = document.getElementById(overlayId);
            const okBtn = document.getElementById(okBtnId);

            // 清理函数
            const cleanup = () => {
                if (overlay && overlay.parentNode) {
                    overlay.parentNode.removeChild(overlay);
                }
                resolve();
            };

            // 绑定确定按钮事件
            okBtn.addEventListener('click', cleanup);

            // 绑定ESC键事件
            const handleKeydown = (e) => {
                if (e.key === 'Escape') {
                    cleanup();
                    document.removeEventListener('keydown', handleKeydown);
                }
            };
            document.addEventListener('keydown', handleKeydown);

            // 点击遮罩层关闭
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    cleanup();
                }
            });
        });
    }

    // 自定义确认对话框
    showCustomConfirm(title, message, confirmText = '确定', cancelText = '取消', isDanger = false) {
        return new Promise((resolve) => {
            // 生成唯一ID
            const modalId = 'customConfirmModal_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            const okBtnId = 'customConfirmOk_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            const cancelBtnId = 'customConfirmCancel_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            
            // 清理已存在的确认对话框
            const existingModals = document.querySelectorAll('.custom-confirm-modal');
            existingModals.forEach(modal => {
                if (modal && modal.parentNode) {
                    modal.parentNode.removeChild(modal);
                }
            });
            
            // 创建模态窗口HTML
            const confirmModalHTML = `
                <div id="${modalId}" class="custom-confirm-modal" style="display: none;">
                    <div class="custom-confirm-content">
                        <div class="custom-confirm-header">
                            <h3>${title}</h3>
                        </div>
                        <div class="custom-confirm-body">
                            <p>${message.replace(/\n/g, '<br>')}</p>
                        </div>
                        <div class="custom-confirm-footer">
                            <button id="${cancelBtnId}" class="custom-confirm-btn cancel-btn">${cancelText}</button>
                            <button id="${okBtnId}" class="custom-confirm-btn confirm-btn${isDanger ? ' danger' : ''}">${confirmText}</button>
                        </div>
                    </div>
                </div>
            `;

            // 添加样式（如果不存在）
            if (!document.getElementById('customConfirmModalStyle')) {
                const confirmStyleHTML = `
                    <style id="customConfirmModalStyle">
                        .custom-confirm-modal {
                            display: none;
                            position: fixed;
                            z-index: 10003;
                            left: 0;
                            top: 0;
                            width: 100%;
                            height: 100%;
                            background-color: rgba(0,0,0,0.6);
                            opacity: 0;
                            transition: opacity 0.3s ease-out;
                        }

                        .custom-confirm-modal.show {
                            display: block;
                            opacity: 1;
                        }

                        .custom-confirm-content {
                            background-color: #fefefe;
                            position: absolute;
                            top: 30%;
                            left: 0;
                            bottom: 0;
                            right: 0;
                            width: 70%;
                            height: fit-content;
                            max-width: 80vw;
                            min-width: 60vw;
                            margin: auto;
                            border: 0.2vw solid #888;
                            border-radius: 2vw;
                            overflow: hidden;
                            transform: scale(0.7);
                            opacity: 0;
                            transition: transform 0.3s ease-out, opacity 0.3s ease-out;
                        }

                        .custom-confirm-modal.show .custom-confirm-content {
                            transform: scale(1);
                            opacity: 1;
                        }

                        .custom-confirm-header {
                            background-color: #f5f5f5;
                            padding: 4vw;
                            border-bottom: 0.2vw solid #ddd;
                            text-align: center;
                        }

                        .custom-confirm-header h3 {
                            margin: 0;
                            font-size: 5vw;
                            font-family: 'FZH', sans-serif;
                            color: #333;
                        }

                        .custom-confirm-body {
                            padding: 6vw 4vw;
                            text-align: center;
                            line-height: 1.6;
                        }

                        .custom-confirm-body p {
                            margin: 0;
                            font-size: 4vw;
                            color: #555;
                            font-family: 'FZH', sans-serif;
                        }

                        .custom-confirm-footer {
                            padding: 3vw 4vw 4vw;
                            display: flex;
                            justify-content: center;
                            gap: 3vw;
                            background-color: #f9f9f9;
                        }

                        .custom-confirm-btn {
                            padding: 2.5vw 6vw;
                            border: none;
                            border-radius: 1.5vw;
                            cursor: pointer;
                            font-size: 4vw;
                            font-family: 'FZH', sans-serif;
                            font-weight: bold;
                            transition: all 0.2s ease-out;
                            min-width: 20vw;
                        }

                        .custom-confirm-btn:active {
                            transform: scale(0.95);
                        }

                        .cancel-btn {
                            background-color: #f5f5f5;
                            color: #666;
                            border: 0.2vw solid #ddd;
                        }

                        .cancel-btn:hover {
                            background-color: #e9e9e9;
                            color: #333;
                        }

                        .confirm-btn {
                            background-color: #2196F3;
                            color: white;
                        }

                        .confirm-btn:hover {
                            background-color: #1976D2;
                        }

                        .confirm-btn.danger {
                            background-color: #f44336;
                        }

                        .confirm-btn.danger:hover {
                            background-color: #d32f2f;
                        }

                        @media (max-width: 768px) {
                            .custom-confirm-content {
                                width: 85%;
                                margin: 15% auto;
                            }

                            .custom-confirm-header h3 {
                                font-size: 4.5vw;
                            }

                            .custom-confirm-body p {
                                font-size: 3.5vw;
                            }

                            .custom-confirm-btn {
                                font-size: 3.5vw;
                                padding: 2vw 5vw;
                                min-width: 18vw;
                            }
                        }

                        @media (max-width: 480px) {
                            .custom-confirm-content {
                                width: 90%;
                            }

                            .custom-confirm-header h3 {
                                font-size: 4vw;
                            }

                            .custom-confirm-body p {
                                font-size: 3.2vw;
                            }

                            .custom-confirm-btn {
                                font-size: 3.2vw;
                                padding: 1.8vw 4vw;
                                min-width: 16vw;
                            }

                            .custom-confirm-footer {
                                gap: 2vw;
                            }
                        }
                    </style>
                `;
                document.head.insertAdjacentHTML('beforeend', confirmStyleHTML);
            }

            // 添加模态窗口到页面
            document.body.insertAdjacentHTML('beforeend', confirmModalHTML);

            const modal = document.getElementById(modalId);
            const confirmBtn = document.getElementById(okBtnId);
            const cancelBtn = document.getElementById(cancelBtnId);

            // 绑定事件
            const cleanup = () => {
                modal.classList.remove('show');
                setTimeout(() => {
                    if (modal && modal.parentNode) {
                        document.body.removeChild(modal);
                    }
                }, 300);
            };

            confirmBtn.addEventListener('click', () => {
                cleanup();
                resolve(true);
            });

            cancelBtn.addEventListener('click', () => {
                cleanup();
                resolve(false);
            });

            // 点击背景关闭
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    cleanup();
                    resolve(false);
                }
            });

            // 显示模态窗口
            modal.style.display = 'block';
            modal.offsetHeight; // 强制重排
            modal.classList.add('show');
        });
    }

    async showAddAllDialog() {
        // 使用自定义确认对话框
        const confirmed = await this.showCustomConfirm(
            '批量查询确认',
            '确定要查询所有线路并批量添加车牌记录吗？\n此操作可能需要较长时间，请耐心等待。',
            '开始查询',
            '取消'
        );
        
        if (!confirmed) {
            return;
        }

        // 添加停止标志
        this.shouldStopBatchQuery = false;

        // 显示进度提示遮罩层
        const progressOverlay = document.createElement('div');
        progressOverlay.id = 'batchAddOverlay';
        progressOverlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.6);
            z-index: 10001;
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        // 显示进度提示窗口
        const progressDiv = document.createElement('div');
        progressDiv.id = 'batchAddProgress';
        progressDiv.style.cssText = `
            background: white;
            padding: 4vw;
            border: 0.3vw solid #ccc;
            border-radius: 2vw;
            box-shadow: 0 0.8vw 1.6vw rgba(0,0,0,0.4);
            font-family: 'FZH', sans-serif;
            font-size: 4vw;
            text-align: center;
            min-width: 60vw;
            max-width: 80vw;
            position: relative;
        `;

        // 针对小屏幕的响应式调整
        if (window.innerWidth <= 768) {
            progressDiv.style.minWidth = '70vw';
            progressDiv.style.maxWidth = '90vw';
            progressDiv.style.padding = '5vw';
        }
        if (window.innerWidth <= 480) {
            progressDiv.style.minWidth = '80vw';
            progressDiv.style.maxWidth = '95vw';
            progressDiv.style.padding = '6vw';
        }

        // 将进度窗口添加到遮罩层中
        progressOverlay.appendChild(progressDiv);
        progressDiv.innerHTML = `
            <style>
                @keyframes progressPulse {
                    0% { box-shadow: 0 0 0.5vw rgba(0, 120, 215, 0.3); }
                    50% { box-shadow: 0 0 1vw rgba(0, 120, 215, 0.6); }
                    100% { box-shadow: 0 0 0.5vw rgba(0, 120, 215, 0.3); }
                }
                
                @keyframes progressShimmer {
                    0% { transform: translateX(-100%); }
                    100% { transform: translateX(100%); }
                }
                
                .progress-container {
                    position: relative;
                    overflow: hidden;
                }
                
                .progress-shimmer {
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: linear-gradient(
                        90deg,
                        transparent 0%,
                        rgba(255, 255, 255, 0.4) 50%,
                        transparent 100%
                    );
                    animation: progressShimmer 2s ease-in-out infinite;
                    border-radius: inherit;
                }
            </style>
            
            <div style="font-size: 4.5vw; margin-bottom: 3vw; font-weight: bold; color: #2c3e50;">正在批量查询线路...</div>
            
            <!-- 进度条容器 -->
            <div style="margin-bottom: 3vw;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5vw;">
                    <span id="progressPercent" style="font-size: 3.2vw; color: #34495e; font-weight: 600;">0%</span>
                    <span id="progressCount" style="font-size: 3.2vw; color: #7f8c8d;">0/0</span>
                </div>
                <div class="progress-container" style="
                    width: 100%;
                    height: 1.6vw;
                    background: linear-gradient(180deg, #f8f9fa 0%, #e9ecef 50%, #dee2e6 100%);
                    border-radius: 0.8vw;
                    border: 0.05vw solid #ced4da;
                    box-shadow: 
                        inset 0 0.1vw 0.2vw rgba(0,0,0,0.1),
                        0 0.05vw 0.1vw rgba(255,255,255,0.8);
                ">
                    <div id="progressBar" style="
                        width: 0%;
                        height: 100%;
                        background: linear-gradient(180deg, 
                            #0078d4 0%, 
                            #106ebe 25%, 
                            #005a9e 75%, 
                            #004578 100%
                        );
                        border-radius: 0.8vw;
                        transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
                        position: relative;
                        animation: progressPulse 2s ease-in-out infinite;
                        box-shadow: 
                            0 0 0.3vw rgba(0, 120, 212, 0.4),
                            inset 0 0.05vw 0.1vw rgba(255,255,255,0.3);
                    ">
                        <div class="progress-shimmer"></div>
                    </div>
                </div>
            </div>
            
            <div id="progressText" style="font-size: 3.5vw; color: #666; margin-bottom: 4vw;">
                准备中...<br>

            </div>
            <div style="margin-top: 3vw;">
                <button id="stopBatchBtn" style="
                    padding: 2vw 4vw;
                    background-color: #f44336;
                    color: white;
                    border: none;
                    border-radius: 1.5vw;
                    cursor: pointer;
                    font-family: 'FZH', sans-serif;
                    font-size: 3.5vw;
                    transition: all 0.1s ease-out;
                ">停止查询</button>
            </div>
        `;
        
        // 为停止按钮添加点击效果
        progressDiv.querySelector('#stopBatchBtn').addEventListener('mousedown', function() {
            this.style.transform = 'scale(0.95)';
        });
        progressDiv.querySelector('#stopBatchBtn').addEventListener('mouseup', function() {
            this.style.transform = 'scale(1)';
        });
        progressDiv.querySelector('#stopBatchBtn').addEventListener('mouseleave', function() {
            this.style.transform = 'scale(1)';
        });
        
        // 防止点击遮罩层时事件穿透
        progressOverlay.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            // 只允许点击内部的progressDiv区域
            if (e.target === progressOverlay) {
                // 点击了遮罩背景，不做任何处理
                return false;
            }
        });

        // 防止progressDiv内部的点击事件冒泡到遮罩层
        progressDiv.addEventListener('click', function(e) {
            e.stopPropagation();
        });

        // 添加键盘事件处理，禁用其他键盘操作
        const keyboardHandler = function(e) {
            // 只允许ESC键（可以触发停止查询）
            if (e.key !== 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        };
        document.addEventListener('keydown', keyboardHandler, true);
        document.addEventListener('keyup', keyboardHandler, true);
        document.addEventListener('keypress', keyboardHandler, true);

        // 存储键盘处理器引用，用于后续清理
        progressOverlay.keyboardHandler = keyboardHandler;

        document.body.appendChild(progressOverlay);

        // 绑定停止按钮事件
        document.getElementById('stopBatchBtn').addEventListener('click', async () => {
            const confirmed = await this.showCustomConfirm(
                '停止查询确认',
                '确定要停止批量查询吗？',
                '停止查询',
                '继续查询'
            );
            
            if (confirmed) {
                this.shouldStopBatchQuery = true;
                document.getElementById('progressText').innerHTML = `
                    正在停止查询...<br>
                `;
                
                // 将进度条改为红色表示停止状态
                const progressBar = document.getElementById('progressBar');
                if (progressBar) {
                    progressBar.style.background = 'linear-gradient(90deg, #f44336, #d32f2f)';
                    progressBar.style.boxShadow = '0 0.1vw 0.3vw rgba(244, 67, 54, 0.3)';
                }
                
                document.getElementById('stopBatchBtn').disabled = true;
                document.getElementById('stopBatchBtn').style.opacity = '0.5';
            }
        });

        try {
            // 在批量查询开始前，禁用主程序的自动刷新功能
            console.log('批量查询开始，禁用自动刷新功能');
            this.disableAutoRefresh();
            
            // 获取所有线路数据
            const allLines = this.getAllLinesFromMainProgram();
            if (!allLines || allLines.length === 0) {
                // 恢复自动刷新功能
                this.enableAutoRefresh();
                
                // 移除进度提示遮罩层
                const overlayElement = document.getElementById('batchAddOverlay');
                if (overlayElement) {
                    // 移除键盘事件监听器
                    if (overlayElement.keyboardHandler) {
                        document.removeEventListener('keydown', overlayElement.keyboardHandler, true);
                        document.removeEventListener('keyup', overlayElement.keyboardHandler, true);
                        document.removeEventListener('keypress', overlayElement.keyboardHandler, true);
                    }
                    document.body.removeChild(overlayElement);
                }
                await this.showCustomAlert('获取数据失败', '无法获取线路数据，请确保主程序已加载');
                return;
            }
            
            // 更新准备完成状态
            document.getElementById('progressText').innerHTML = '准备完成，开始查询...<br>';
            
            // 短暂停顿显示准备完成状态
            await new Promise(resolve => setTimeout(resolve, 500));

            let totalAdded = 0;
            let processedCount = 0;
            const progressText = document.getElementById('progressText');
            const progressBar = document.getElementById('progressBar');
            const progressPercent = document.getElementById('progressPercent');
            const progressCount = document.getElementById('progressCount');

            // 时间跟踪变量
            const batchStartTime = Date.now();
            let lastProcessTime = batchStartTime;
            const processingTimes = [];

            // 保存当前线路状态
            const originalLineId = window.globalLineId;
            const originalLineName = window.global_line_name;

            // 初始化进度条
            const totalLines = allLines.filter(l => l.code !== 'DZ').length;
            progressCount.textContent = `0/${totalLines}`;
            progressPercent.textContent = '0%';
            progressBar.style.width = '0%';

            // 准备车来了ID：只使用已有的本地存储和预设映射
            console.log('=== 准备车来了线路ID（只使用已有ID）===');
            const { lineIdMapping, skippedLines } = await this.batchGetChelaileLineIds(allLines);
            
            // 检查是否被用户停止
            if (this.shouldStopBatchQuery) {
                console.log('ID准备阶段中用户停止了查询');
                throw new Error('用户停止查询');
            }

            // 直接进入车牌查询：使用准备好的ID批量查询车牌信息
            console.log('=== 批量查询车牌信息 ===');
            const queryResults = await this.batchQueryLicensesByIds(lineIdMapping);
            totalAdded = queryResults.addedCount;

            // 计算处理的线路数（包括成功和失败的）
            processedCount = allLines.length;

            // 恢复原来的线路状态
            if (originalLineId) {
                window.globalLineId = originalLineId;
            }
            if (originalLineName) {
                window.global_line_name = originalLineName;
            }

            // 显示完成状态
            if (!this.shouldStopBatchQuery) {
                // 查询完成时更新进度条为100%
                const progressBar = document.getElementById('progressBar');
                const progressPercent = document.getElementById('progressPercent');
                const progressCount = document.getElementById('progressCount');
                
                if (progressBar && progressPercent && progressCount) {
                    progressBar.style.width = '100%';
                    progressPercent.textContent = '100%';
                    const finalProcessedCount = Object.keys(lineIdMapping).length;
                    progressCount.textContent = `${finalProcessedCount}/${finalProcessedCount}`;
                    
                    // 短暂显示完成状态
                    progressText.innerHTML = '查询完成！';
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            // 移除进度提示遮罩层
            if (document.getElementById('batchAddOverlay')) {
                // 移除键盘事件监听器
                if (progressOverlay.keyboardHandler) {
                    document.removeEventListener('keydown', progressOverlay.keyboardHandler, true);
                    document.removeEventListener('keyup', progressOverlay.keyboardHandler, true);
                    document.removeEventListener('keypress', progressOverlay.keyboardHandler, true);
                }
                document.body.removeChild(progressOverlay);
            }

            // 批量查询结束，恢复自动刷新功能
            console.log('批量查询结束，恢复自动刷新功能');
            this.enableAutoRefresh();

            // 清除缓存
            this.clearCache();

            // 更新显示
            this.updateStatistics();
            this.loadRecords();

            // 计算总用时
            const batchEndTime = Date.now();
            const totalDuration = this.formatDuration(batchEndTime - batchStartTime);
            
            // 计算实际查询的线路数（排除没有ID的跳过线路）
            const actualQueryCount = Object.keys(lineIdMapping).length;
            // 实际处理的线路数：成功+跳过的总数
            const actualProcessedCount = allLines.length - skippedLines;

            // 根据是否被终止显示不同的提示信息
            if (this.shouldStopBatchQuery) {
                await this.showCustomAlert('查询已停止', 
                    `批量查询已停止！\n` +
                    `查询了 ${actualQueryCount} 条线路\n` +
                    `获取到 ${queryResults.fetchedCount} 辆车牌记录\n` +
                    `已添加 ${queryResults.addedCount} 条记录\n` +
                    `总用时 ${totalDuration}`
                );
            } else {
                await this.showCustomAlert('查询完成', 
                    `批量查询完成！\n` +
                    `查询了 ${actualQueryCount} 条线路\n` +
                    `获取到 ${queryResults.fetchedCount} 辆车牌记录\n` +
                    `已添加 ${queryResults.addedCount} 条记录\n` +
                    `总用时 ${totalDuration}`
                );
            }

            // 进度条最终显示：使用实际处理的线路数（排除了无ID跳过的线路）
            if (progressCount) {
                progressCount.textContent = `${actualProcessedCount}/${actualProcessedCount}`;
            }

            // 批量查询结束，不需要刷新界面
            // 只在单次查询时才需要refresh，批量查询已经添加了所有记录
            console.log('批量查询完成，记录已全部添加到本地存储');

        } catch (error) {
            console.error('批量添加失败:', error);
            
            // 发生异常时也要恢复自动刷新功能
            console.log('批量查询异常，恢复自动刷新功能');
            this.enableAutoRefresh();
            
            // 更新进度条为错误状态
            const progressBar = document.getElementById('progressBar');
            const progressText = document.getElementById('progressText');
            if (progressBar && progressText) {
                progressBar.style.background = 'linear-gradient(90deg, #f44336, #d32f2f)';
                progressBar.style.boxShadow = '0 0.1vw 0.3vw rgba(244, 67, 54, 0.3)';
                progressText.innerHTML = '查询失败！';
                
                // 短暂显示错误状态
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            const overlayElement = document.getElementById('batchAddOverlay');
            if (overlayElement) {
                // 移除键盘事件监听器
                if (overlayElement.keyboardHandler) {
                    document.removeEventListener('keydown', overlayElement.keyboardHandler, true);
                    document.removeEventListener('keyup', overlayElement.keyboardHandler, true);
                    document.removeEventListener('keypress', overlayElement.keyboardHandler, true);
                }
                document.body.removeChild(overlayElement);
            }
            await this.showCustomAlert('查询失败', '批量查询失败: ' + error.message);
        }
    }

    // 获取主程序中的所有线路数据
    getAllLinesFromMainProgram() {
        // 尝试从全局变量或DOM中获取线路数据
        if (window.sortedLineList && window.sortedLineList.length > 0) {
            return window.sortedLineList;
        }
        
        // 如果没有全局变量，尝试重新获取
        return null;
    }

    // 批量查询车牌：直接使用已有的车来了ID
    async batchGetChelaileLineIds(allLines) {
        console.log(`开始准备批量查询车牌：检查 ${allLines.length} 条线路`);
        
        const progressText = document.getElementById('progressText');
        const progressBar = document.getElementById('progressBar');
        const progressPercent = document.getElementById('progressPercent');
        const progressCount = document.getElementById('progressCount');

        // 存储线路ID映射：{lineId: {upLineId, downLineId, lineName, lineNo}}
        const lineIdMapping = {};
        
        console.log('=== 检查本地存储的车来了ID ===');
        progressText.innerHTML = '检查本地存储的车来了ID...<br><div style="font-size: 3vw; color: #888; margin: 1vw 0;">只查询已有ID的线路</div>';
        
        let linesWithIds = 0;
        let skippedLines = 0;
        
        for (const line of allLines) {
            // 跳过定制线路
            if (line.code === 'DZ') {
                continue;
            }
            
            // 检查本地存储
            let hasLocalId = false;
            if (window.localStorageManager) {
                const localMapping = window.localStorageManager.getMapping(line.code);
                if (localMapping) {
                    lineIdMapping[line.code] = {
                        upLineId: localMapping.upLineId,
                        downLineId: localMapping.downLineId,
                        lineName: localMapping.lineName || line.originalName,
                        lineNo: localMapping.upLineId,
                        originalName: line.originalName,
                        price: line.price
                    };
                    linesWithIds++;
                    hasLocalId = true;
                    console.log(`${line.originalName}: 使用本地存储 (来源: ${localMapping.source})`);
                }
            }
            
            // 检查预设映射
            if (!hasLocalId && window.presetLineMapping && window.presetLineMapping[line.code]) {
                const mapping = window.presetLineMapping[line.code];
                lineIdMapping[line.code] = {
                    upLineId: mapping.upLineId,
                    downLineId: mapping.downLineId,
                    lineName: mapping.lineName || line.originalName,
                    lineNo: mapping.lineNo || mapping.upLineId,
                    originalName: line.originalName,
                    price: line.price
                };
                linesWithIds++;
                hasLocalId = true;
                console.log(`${line.originalName}: 使用预设映射`);
            }
            
            // 如果没有本地ID，直接跳过
            if (!hasLocalId) {
                skippedLines++;
                console.log(`跳过没有车来了ID的线路: ${line.originalName} (${line.code})`);
            }
        }
        
        console.log(`可查询的线路: ${linesWithIds} 条`);
        console.log(`跳过的线路: ${skippedLines} 条（没有车来了ID）`);
        
        // 显示准备结果
        if (linesWithIds === 0) {
            progressText.innerHTML = '没有找到任何有车来了ID的线路<br><div style="font-size: 3vw; color: #ff9800; margin: 1vw 0;">请先使用单线路查询获取线路ID</div>';
        } else {
            progressText.innerHTML = `准备完成：${linesWithIds} 条线路可查询车牌<br><div style="font-size: 3vw; color: #4CAF50; margin: 1vw 0;">${skippedLines > 0 ? `跳过 ${skippedLines} 条无ID线路` : '所有线路都可查询'}</div>`;
        }
        
        progressBar.style.width = '100%';
        progressPercent.textContent = '100%';
        progressCount.textContent = `${linesWithIds}/${linesWithIds}`;
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        return { lineIdMapping, skippedLines };
    }


    // 获取单条线路的车来了上下行ID（不查询车牌）
    async getChelaileLineIdsForLine(line, forceRequery = false) {
        return new Promise(async (resolve) => {
            try {
                const targetLineId = line.code;
                const targetLineName = line.originalName;

                // 如果不强制重新查询，使用现有优先级逻辑
                if (!forceRequery) {
                // 第一优先级：检查本地存储的映射关系
                if (window.localStorageManager) {
                    const localMapping = window.localStorageManager.getMapping(targetLineId);
                    if (localMapping) {
                        console.log(`使用本地存储获取 ${targetLineName} 的车来了ID (来源: ${localMapping.source})`);
                        resolve({
                            upLineId: localMapping.upLineId,
                            downLineId: localMapping.downLineId,
                            lineName: localMapping.lineName || targetLineName,
                            lineNo: localMapping.upLineId
                        });
                        return;
                    }
                }

                // 第二优先级：检查预设映射
                if (window.presetLineMapping && window.presetLineMapping[targetLineId]) {
                    const mapping = window.presetLineMapping[targetLineId];
                    console.log(`使用预设映射获取 ${targetLineName} 的车来了ID`);
                    resolve({
                        upLineId: mapping.upLineId,
                        downLineId: mapping.downLineId,
                        lineName: mapping.lineName || targetLineName,
                        lineNo: mapping.lineNo || mapping.upLineId
                    });
                    return;
                    }
                } else {
                    console.log(`强制重新查询 ${targetLineName} 的车来了ID`);
                }

                // 切换到目标线路
                window.globalLineId = targetLineId;
                window.global_line_name = targetLineName;

                // 调用主程序获取线路信息
                if (typeof window.getlineinfo === 'function') {
                    window.getlineinfo();
                    // 等待线路信息加载完成
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }

                // 调用车来了查询，但不获取车牌
                if (typeof window.queryChelaileInfo === 'function') {
                    window.queryChelaileInfo();
                    
                    // 等待车来了查询完成
                    let attempts = 0;
                    const maxAttempts = 10; // 最多等待10秒
                    
                    while (attempts < maxAttempts) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        attempts++;
                        
                        // 检查是否获取到车来了ID
                        if (window.global_cll_uplineid || window.global_cll_downlineid) {
                            const result = {
                                upLineId: window.global_cll_uplineid,
                                downLineId: window.global_cll_downlineid,
                                lineName: window.global_cll_name || targetLineName,
                                lineNo: window.global_cll_lineNo
                            };
                            console.log(`API查询获取 ${targetLineName} 的车来了ID成功`);
                            resolve(result);
                            return;
                        }
                        
                        // 检查是否需要停止
                        if (this.shouldStopBatchQuery) {
                            resolve(null);
                            return;
                        }
                    }
                }
                
                // 超时或未获取到ID
                console.log(`获取 ${targetLineName} 的车来了ID超时或失败`);
                resolve(null);
                
            } catch (error) {
                console.error(`获取线路 ${line.originalName} 的车来了ID异常:`, error);
                resolve(null);
            }
        });
    }

    // 批量查询车牌信息：使用准备好的车来了ID（并发版本）
    async batchQueryLicensesByIds(lineIdMapping) {
        console.log(`开始批量查询车牌：使用 ${Object.keys(lineIdMapping).length} 条线路的ID（全并发模式）`);
        
        const progressText = document.getElementById('progressText');
        const progressBar = document.getElementById('progressBar');
        const progressPercent = document.getElementById('progressPercent');
        const progressCount = document.getElementById('progressCount');

        const lineEntries = Object.entries(lineIdMapping);
        const totalLines = lineEntries.length;
        let completedCount = 0;

        // 重置进度条为车牌查询阶段
        progressCount.textContent = `0/${totalLines}`;
        progressPercent.textContent = '0%';
        progressBar.style.width = '0%';

        // 显示正在查询的状态
        progressText.innerHTML = `
            正在并发查询所有 ${totalLines} 条线路...<br>
            <div style="font-size: 2.5vw; color: #666; margin: 0.5vw 0;">
            </div>
            <div style="font-size: 2.8vw; color: #4CAF50; margin: 0.5vw 0;">
                已完成: 0/${totalLines}
            </div>
        `;

        // 创建所有查询Promise，并在每个完成时更新进度
        const allPromises = lineEntries.map(async ([lineCode, lineData]) => {
            try {
                // 检查是否需要停止查询
                if (this.shouldStopBatchQuery) {
                    console.log('车牌查询被用户停止');
                    return {
                        lineCode,
                        lineName: lineData.originalName,
                        success: false,
                        fetchedCount: 0
                    };
                }

                // 查询上下行车牌信息，返回详细统计
                const queryResult = await this.queryLicensesByLineIds(lineCode, lineData);
                
                // 更新完成计数和进度条
                completedCount++;
                const progress = Math.round((completedCount / totalLines) * 100);
                progressBar.style.width = `${progress}%`;
                progressPercent.textContent = `${progress}%`;
                progressCount.textContent = `${completedCount}/${totalLines}`;
                
                // 更新进度显示
                progressText.innerHTML = `
                    正在并发查询所有 ${totalLines} 条线路...<br>
                    <div style="font-size: 2.5vw; color: #666; margin: 0.5vw 0;">
                    </div>
                    <div style="font-size: 2.8vw; color: #4CAF50; margin: 0.5vw 0;">
                        已完成: ${completedCount}/${totalLines}
                    </div>
                `;
                
                if (queryResult.fetchedCount > 0) {
                    console.log(`✓ ${lineData.originalName} 获取 ${queryResult.fetchedCount} 辆车`);
                } else {
                    console.log(`- ${lineData.originalName} 当前无车在线`);
                }
                
                return {
                    lineCode,
                    lineName: lineData.originalName,
                    success: true,
                    fetchedCount: queryResult.fetchedCount || 0,
                    addedCount: queryResult.addedCount || 0
                };
                
            } catch (error) {
                completedCount++;
                console.error(`✗ 查询 ${lineData.originalName} 失败:`, error);
                
                // 即使失败也更新进度
                const progress = Math.round((completedCount / totalLines) * 100);
                progressBar.style.width = `${progress}%`;
                progressPercent.textContent = `${progress}%`;
                progressCount.textContent = `${completedCount}/${totalLines}`;
                
                return {
                    lineCode,
                    lineName: lineData.originalName,
                    success: false,
                    fetchedCount: 0,
                    addedCount: 0
                };
            }
        });

        // 等待所有查询完成
        const allResults = await Promise.all(allPromises);
        
        // 统计最终结果（使用每条线路返回的实际添加数累加，避免差值计算不准确）
        const totalAdded = allResults.reduce((sum, r) => sum + (r.addedCount || 0), 0);
        const totalFetched = allResults.reduce((sum, r) => sum + r.fetchedCount, 0);
        const successCount = allResults.filter(r => r.success).length;
        
        console.log(`车牌查询完成：成功 ${successCount}/${totalLines} 条线路，获取 ${totalFetched} 辆车，添加 ${totalAdded} 条记录`);
        
        return {
            addedCount: totalAdded,
            fetchedCount: totalFetched
        };
    }

    // 使用车来了线路ID查询车牌信息
    async queryLicensesByLineIds(lineCode, lineData) {
        return new Promise(async (resolve) => {
            try {
                const { upLineId, downLineId, lineName, originalName } = lineData;
                let totalLicenses = [];

                // 应用线路名重命名规则，确保与单次查询一致
                const renamedLineName = busRecordsManager.applyLineNameRenaming(originalName);

                // 查询上行
                if (upLineId) {
                    console.log(`查询 ${originalName} 上行车牌 (ID: ${upLineId})`);
                    const upLicenses = await this.queryLicensesByDirectionId(upLineId, lineCode, renamedLineName, '上行');
                    if (upLicenses && upLicenses.length > 0) {
                        totalLicenses.push(...upLicenses);
                    }
                }

                // 查询下行
                if (downLineId) {
                    console.log(`查询 ${originalName} 下行车牌 (ID: ${downLineId})`);
                    const downLicenses = await this.queryLicensesByDirectionId(downLineId, lineCode, renamedLineName, '下行');
                    if (downLicenses && downLicenses.length > 0) {
                        totalLicenses.push(...downLicenses);
                    }
                }

                // 记录获取到的总车牌数
                const fetchedCount = totalLicenses.length;

                // 去重处理
                const uniqueLicenses = this.removeDuplicateBusLicenses(totalLicenses, `${lineCode}_batch`);
                
                // 添加记录到管理器（等待写入完成）
                let actualAddedCount = 0;
                if (uniqueLicenses.length > 0) {
                    actualAddedCount = await busRecordsManager.addBatchRecords(uniqueLicenses, lineCode, renamedLineName);
                }

                resolve({
                    addedCount: actualAddedCount,
                    fetchedCount: fetchedCount
                });
                
            } catch (error) {
                console.error(`查询线路 ${lineData.originalName} 车牌异常:`, error);
                resolve({
                    addedCount: 0,
                    fetchedCount: 0
                });
            }
        });
    }

    // 使用单个方向的车来了ID查询车牌（新加密接口版本）
    async queryLicensesByDirectionId(lineId, lineCode, lineName, direction) {
        return new Promise((resolve) => {
            try {
                // =========================
                // 使用车来了新接口（加密版）
                // encRefreshLineDetail.action + encryptResult + AES-ECB 解密
                // =========================
                const chelaileParams = {
                    cityId: '560',
                    deviceType: 'MI 6',
                    cryptoSign: 'e3bb3d4574f54e6f426999bac3757500',
                    lineId: lineId,
                    userAgent: 'Mozilla/5.0 (Linux; Android 9; MI 6 Build/PKQ1.190118.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/80.0.3987.99 Mobile Safari/537.36',
                    s: 'android',
                    v: '1.92.0',
                    sign: 'ni2i/Oyxzz3vDP/OxB1zzg==',
                    cityName: '连云港',
                    targetOrder: '1'
                };

                const chelaileUrl = "https://cdn.api.chelaile.net.cn/bus/line!encRefreshLineDetail.action?" +
                    Object.keys(chelaileParams).map(key => key + '=' + encodeURIComponent(chelaileParams[key])).join('&');

                const xhr = new XMLHttpRequest();
                xhr.open("GET", chelaileUrl);
                xhr.onreadystatechange = () => {
                    if (xhr.readyState === 4 && xhr.status === 200) {
                        try {
                            // 同样带有 YGKJ 前后缀，先去掉
                            const response = xhr.responseText.replace("YGKJ##", "").replace("**YGKJ", "");
                            const data = JSON.parse(response);

                            // 1. 拿到 encryptResult 密文
                            const encryptResult = data &&
                                data.jsonr && data.jsonr.data &&
                                data.jsonr.data.encryptResult;

                            if (!encryptResult) {
                                console.log(`[批量] 车来了返回数据中没有 encryptResult 字段 (${lineName} ${direction})`);
                                resolve([]);
                                return;
                            }

                            // 2. AES-ECB 解密得到明文 JSON（复用主程序中的全局函数）
                            const decryptedJson = typeof decryptChelaileEncryptResult === 'function'
                                ? decryptChelaileEncryptResult(encryptResult)
                                : null;

                            if (!decryptedJson) {
                                console.log(`[批量] 车来了 encryptResult 解密失败 (${lineName} ${direction})`);
                                resolve([]);
                                return;
                            }

                            // 3. 从 modules[*].data.buses[*] 中收集 busId/order
                            const buses = [];
                            if (Array.isArray(decryptedJson.modules)) {
                                decryptedJson.modules.forEach((module) => {
                                    if (module && module.data && Array.isArray(module.data.buses)) {
                                        module.data.buses.forEach((bus) => {
                                            if (bus && bus.busId) {
                                                buses.push(bus);
                                            }
                                        });
                                    }
                                });
                            }

                            if (buses.length > 0) {
                                // busId 去重
                                const uniqueBuses = Array.from(new Map(buses.map(bus => [bus.busId, bus])).values());

                                // 按 order 排序
                                uniqueBuses.sort((a, b) => (a.order || 0) - (b.order || 0));

                                // 构建结果前先确保车牌代号纠正功能已初始化
                                if (!busRecordsManager._busIdCorrectionMap) {
                                    busRecordsManager.initBusIdCorrectionMap();
                                }

                                const result = uniqueBuses.map(bus => ({
                                    busId: busRecordsManager.correctBusId(bus.busId), // 纠正车牌代号
                                    order: bus.order,
                                    _lineCode: lineCode,
                                    _lineName: lineName,
                                    _direction: direction,
                                    _chelaileLineId: lineId,
                                    _queryTimestamp: Date.now(),
                                    _originalBusId: bus.busId // 保留原始车牌代号用于调试
                                }));

                                console.log(`[批量] ${lineName} ${direction} 获取到 ${result.length} 辆车`);
                                resolve(result);
                            } else {
                                console.log(`[批量] ${lineName} ${direction} 当前无车在线`);
                                resolve([]);
                            }
                        } catch (e) {
                            console.error(`[批量] 解析或解密 ${lineName} ${direction} 车牌数据异常:`, e);
                            resolve([]);
                        }
                    } else if (xhr.readyState === 4) {
                        console.error(`[批量] 查询 ${lineName} ${direction} 车牌请求失败:`, xhr.status);
                        resolve([]);
                    }
                };

                // 设置超时
                xhr.timeout = 10000;
                xhr.ontimeout = () => {
                    console.error(`[批量] 查询 ${lineName} ${direction} 车牌请求超时`);
                    resolve([]);
                };

                xhr.send();
            } catch (error) {
                console.error(`查询 ${lineName} ${direction} 车牌异常:`, error);
                resolve([]);
            }
        });
    }

    // 查询指定线路并获取车牌信息（同时查询上下行）
    async queryLineAndAddRecords(line) {
        return new Promise(async (resolve, reject) => {
            try {
                // 检查是否应该停止查询
                if (this.shouldStopBatchQuery) {
                    resolve([]);
                    return;
                }

                // 保存当前要查询的线路信息，防止异步操作期间线路发生变化
                const targetLineId = line.code;
                const targetLineName = line.originalName;

                // 生成唯一的查询ID，防止异步查询结果混乱
                const queryId = `${targetLineId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                
                console.log(`开始查询线路: ${targetLineName} (${targetLineId}) - 查询ID: ${queryId} [上下行双向]`);

                // 调用主程序的刷新功能
                if (typeof window.refresh === 'function') {
                    window.refresh();
                }
                
                // 存储所有方向的车牌信息
                const allBusLicenses = [];
                
                // 查询两个方向：上行(0)和下行(1)
                const directions = [0, 1];
                const directionNames = ['上行', '下行'];
                
                for (let dirIndex = 0; dirIndex < directions.length; dirIndex++) {
                    const direction = directions[dirIndex];
                    const directionName = directionNames[dirIndex];
                    
                    // 检查是否应该停止查询
                    if (this.shouldStopBatchQuery) {
                        console.log(`查询ID ${queryId} 在${directionName}查询前被用户停止`);
                        break;
                    }
                    
                    console.log(`查询ID ${queryId} 开始查询${directionName}方向 (direction: ${direction})`);
                    
                    // 切换到指定方向
                    if (typeof window.switchDirection === 'function') {
                        await window.switchDirection(direction);
                        // 等待方向切换完成
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    } else if (window.globalDirection !== undefined) {
                        // 直接设置全局方向变量
                        window.globalDirection = direction;
                        // 触发刷新以应用方向变化
                        if (typeof window.refresh === 'function') {
                            window.refresh();
                        }
                        await new Promise(resolve => setTimeout(resolve, 1500));
                    }
                    
                    try {
                        // 查询当前方向的车牌信息
                        const directionBusLicenses = await this.queryDirectionBusLicenses(targetLineId, targetLineName, direction, directionName, queryId);
                        
                        if (directionBusLicenses && directionBusLicenses.length > 0) {
                            console.log(`查询ID ${queryId} ${directionName}方向获取到 ${directionBusLicenses.length} 辆车`);
                            allBusLicenses.push(...directionBusLicenses);
                        } else {
                            console.log(`查询ID ${queryId} ${directionName}方向无车在线`);
                        }
                        
                    } catch (error) {
                        console.error(`查询ID ${queryId} ${directionName}方向查询失败:`, error);
                        // 某个方向失败不影响其他方向，继续查询
                    }
                    
                    // 方向间延时，避免请求过于频繁
                    if (dirIndex < directions.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 1500));
                    }
                }
                
                // 去重处理（同一车牌在不同方向可能重复）
                const uniqueBusLicenses = this.removeDuplicateBusLicenses(allBusLicenses, queryId);
                
                if (uniqueBusLicenses.length > 0) {
                    console.log(`查询ID ${queryId} 双向查询完成，去重后获得 ${uniqueBusLicenses.length} 辆车 (原始: ${allBusLicenses.length})`);
                } else {
                    console.log(`查询ID ${queryId} 双向查询完成，当前时段无车在线`);
                }
                
                resolve(uniqueBusLicenses);
                
            } catch (error) {
                console.error(`查询ID ${queryId} 双向查询异常:`, error);
                reject(error);
            }
        });
    }

    // 查询单个方向的车牌信息
    async queryDirectionBusLicenses(targetLineId, targetLineName, direction, directionName, queryId) {
        return new Promise((resolve, reject) => {
            // 使用递归验证机制，确保获取到正确线路的车牌信息
            const attemptQuery = (attemptCount = 0) => {
                const maxAttempts = 3; // 减少重试次数，因为要查询两个方向
                const queryStartTime = Date.now();
                
                setTimeout(() => {
                    // 检查是否应该停止查询
                    if (this.shouldStopBatchQuery) {
                        console.log(`查询ID ${queryId} ${directionName}方向被用户停止`);
                        resolve([]);
                        return;
                    }

                    // 验证查询是否超时（每次重试最多20秒）
                    const queryElapsed = Date.now() - queryStartTime;
                    if (queryElapsed > 20000) {
                        console.log(`查询ID ${queryId} ${directionName}方向超时，跳过`);
                        resolve([]);
                        return;
                    }

                    // 验证当前线路是否是我们要查询的线路
                    if (window.globalLineId !== targetLineId) {
                        if (attemptCount < maxAttempts) {
                            console.log(`查询ID ${queryId} ${directionName}方向第${attemptCount + 1}次验证线路不匹配 (期望: ${targetLineId}, 当前: ${window.globalLineId})，重试...`);
                            attemptQuery(attemptCount + 1);
                            return;
                        } else {
                            console.log(`查询ID ${queryId} ${directionName}方向经过${maxAttempts}次重试仍然线路不匹配，跳过`);
                            resolve([]);
                            return;
                        }
                    }

                    // 验证方向（如果支持方向检查）
                    if (window.globalDirection !== undefined && window.globalDirection !== direction) {
                        if (attemptCount < maxAttempts) {
                            console.log(`查询ID ${queryId} ${directionName}方向第${attemptCount + 1}次验证方向不匹配 (期望: ${direction}, 当前: ${window.globalDirection})，重试...`);
                            attemptQuery(attemptCount + 1);
                            return;
                        } else {
                            console.log(`查询ID ${queryId} ${directionName}方向经过${maxAttempts}次重试仍然方向不匹配，跳过`);
                            resolve([]);
                            return;
                        }
                    }

                    if (typeof window.getbuslicence === 'function') {
                        // 在调用getbuslicence前再次记录线路状态
                        const preCallLineId = window.globalLineId;
                        const preCallLineName = window.global_line_name;
                        const preCallDirection = window.globalDirection;
                        const preCallTime = Date.now();
                        
                        console.log(`查询ID ${queryId} ${directionName}方向准备调用getbuslicence，状态: ${preCallLineId}/${preCallLineName}/方向${preCallDirection}`);

                        // 记录调用前的记录总数
                        const recordsCountBeforeCall = busRecordsManager.records.length;
                        
                        window.getbuslicence()
                            .then(busLicenses => {
                                const postCallTime = Date.now();
                                const callDuration = postCallTime - preCallTime;
                                
                                // 记录调用后的记录总数
                                const recordsCountAfterCall = busRecordsManager.records.length;
                                const addedByGetbuslicence = recordsCountAfterCall - recordsCountBeforeCall;
                                
                                console.log(`查询ID ${queryId} ${directionName}方向getbuslicence调用完成，耗时: ${callDuration}ms，自动添加记录: ${addedByGetbuslicence} 条`);
                                
                                // 严格验证：API返回后立即检查全局状态
                                const currentGlobalLineId = window.globalLineId;
                                const currentGlobalLineName = window.global_line_name;
                                const currentGlobalDirection = window.globalDirection;
                                
                                // 检查调用前后的线路状态是否发生变化
                                if (currentGlobalLineId !== preCallLineId) {
                                    console.warn(`查询ID ${queryId} ${directionName}方向调用期间全局线路ID发生变化，调用前: ${preCallLineId}, 调用后: ${currentGlobalLineId}`);
                                    if (attemptCount < maxAttempts) {
                                        console.log(`查询ID ${queryId} ${directionName}方向第${attemptCount + 1}次调用期间线路ID变化，重试...`);
                                        attemptQuery(attemptCount + 1);
                                        return;
                                    } else {
                                        console.log(`查询ID ${queryId} ${directionName}方向经过${maxAttempts}次重试仍然线路ID变化，跳过`);
                                        resolve([]);
                                        return;
                                    }
                                }
                                
                                // 最严格验证：确保当前全局状态与目标一致
                                if (currentGlobalLineId !== targetLineId) {
                                    console.error(`查询ID ${queryId} ${directionName}方向严重错误：API返回时全局线路ID不匹配目标，目标: ${targetLineId}, 当前: ${currentGlobalLineId}`);
                                    if (attemptCount < maxAttempts) {
                                        console.log(`查询ID ${queryId} ${directionName}方向第${attemptCount + 1}次严重状态不匹配，重试...`);
                                        attemptQuery(attemptCount + 1);
                                        return;
                                    } else {
                                        console.log(`查询ID ${queryId} ${directionName}方向经过${maxAttempts}次重试仍然状态不匹配，强制跳过`);
                                        resolve([]);
                                        return;
                                    }
                                }
                                
                                // 如果车牌信息为空，直接跳过，不重试
                                if (!busLicenses || busLicenses.length === 0) {
                                    console.log(`查询ID ${queryId} ${directionName}方向 - 当前时段无车在线，跳过`);
                                    resolve([]);
                                    return;
                                }
                                
                                // 有车牌信息，添加验证标识和最终状态快照
                                const verifiedBusLicenses = busLicenses.map(bus => ({
                                    ...bus,
                                    _verifiedLineId: targetLineId,
                                    _verifiedLineName: targetLineName,
                                    _queryId: queryId,
                                    _queryTimestamp: Date.now(),
                                    _callDuration: callDuration,
                                    _addedByGetbuslicence: addedByGetbuslicence,
                                    _direction: direction,
                                    _directionName: directionName,
                                    // 添加最终状态验证
                                    _finalGlobalLineId: currentGlobalLineId,
                                    _finalGlobalLineName: currentGlobalLineName,
                                    _finalGlobalDirection: currentGlobalDirection,
                                    _preCallLineId: preCallLineId,
                                    _targetLineId: targetLineId
                                }));
                                
                                console.log(`查询ID ${queryId} ${directionName}方向获取到车牌信息: ${verifiedBusLicenses.length} 辆车 (验证通过)`);
                                resolve(verifiedBusLicenses);
                            })
                            .catch(error => {
                                console.error(`查询ID ${queryId} ${directionName}方向获取车牌信息失败:`, error);
                                if (attemptCount < maxAttempts) {
                                    console.log(`查询ID ${queryId} ${directionName}方向第${attemptCount + 1}次获取车牌信息出错，重试...`);
                                    attemptQuery(attemptCount + 1);
                                } else {
                                    console.log(`查询ID ${queryId} ${directionName}方向经过${maxAttempts}次重试仍然出错，跳过`);
                                    resolve([]);
                                }
                            });
                    } else {
                        console.log(`查询ID ${queryId} ${directionName}方向getbuslicence函数不存在，跳过`);
                        resolve([]);
                    }
                }, 1000 + (attemptCount * 800)); // 递增延时，避免过于频繁的查询
            };
            
            // 开始查询
            attemptQuery();
        });
    }

    // 去除重复的车牌信息（同一车牌在不同方向可能重复）
    removeDuplicateBusLicenses(busLicenses, queryId) {
        if (!busLicenses || busLicenses.length === 0) {
            return [];
        }
        
        const uniqueMap = new Map();
        const duplicateStats = {};
        
        busLicenses.forEach(bus => {
            if (!bus.busId) return;
            
            const busId = bus.busId;
            
            if (uniqueMap.has(busId)) {
                // 记录重复统计
                if (!duplicateStats[busId]) {
                    duplicateStats[busId] = { count: 1, directions: [] };
                }
                duplicateStats[busId].count++;
                if (bus._directionName && !duplicateStats[busId].directions.includes(bus._directionName)) {
                    duplicateStats[busId].directions.push(bus._directionName);
                }
                
                // 保留更完整的信息（优先保留有更多验证信息的记录）
                const existing = uniqueMap.get(busId);
                if (bus._queryTimestamp > existing._queryTimestamp || 
                    (bus._callDuration && bus._callDuration < existing._callDuration)) {
                    // 合并方向信息
                    const combinedDirections = [];
                    if (existing._directionName && !combinedDirections.includes(existing._directionName)) {
                        combinedDirections.push(existing._directionName);
                    }
                    if (bus._directionName && !combinedDirections.includes(bus._directionName)) {
                        combinedDirections.push(bus._directionName);
                    }
                    
                    uniqueMap.set(busId, {
                        ...bus,
                        _combinedDirections: combinedDirections,
                        _isDuplicate: true,
                        _duplicateCount: duplicateStats[busId].count
                    });
                }
            } else {
                uniqueMap.set(busId, {
                    ...bus,
                    _combinedDirections: bus._directionName ? [bus._directionName] : [],
                    _isDuplicate: false
                });
            }
        });
        
        const uniqueBusLicenses = Array.from(uniqueMap.values());
        
        // 记录去重统计信息
        const duplicateCount = Object.keys(duplicateStats).length;
        if (duplicateCount > 0) {
            console.log(`查询ID ${queryId} 去重统计: 发现 ${duplicateCount} 个重复车牌`);
            Object.keys(duplicateStats).forEach(busId => {
                const stat = duplicateStats[busId];
                console.log(`  - 车牌 ${busId}: ${stat.count} 次出现，方向: ${stat.directions.join('、')}`);
            });
        }
        
        return uniqueBusLicenses;
    }

    // 添加线路记录
    async addLineRecords(busLicenses, lineId, lineName) {
        if (!Array.isArray(busLicenses) || busLicenses.length === 0) {
            return 0;
        }

        // 使用本地时间获取今日日期
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        let addedCount = 0;

        // 验证当前全局线路信息是否匹配
        if (window.globalLineId && window.globalLineId !== lineId) {
            console.warn(`添加记录时全局线路ID不匹配，期望: ${lineId}, 当前: ${window.globalLineId}, 跳过添加`);
            return 0;
        }

        if (window.global_line_name) {
            const normalizedGlobalName = this.normalizeLineName(window.global_line_name);
            const normalizedTargetName = this.normalizeLineName(lineName);
            if (normalizedGlobalName !== normalizedTargetName) {
                console.warn(`添加记录时全局线路名称不匹配，期望: ${lineName}, 当前: ${window.global_line_name}, 跳过添加`);
                return 0;
            }
        }

        console.log(`准备添加 ${busLicenses.length} 辆车的记录到线路 ${lineName} (${lineId})`);
        
        // 记录查询ID统计信息
        const queryIdStats = {};
        busLicenses.forEach(bus => {
            if (bus._queryId) {
                const queryLineId = bus._queryId.split('_')[0];
                if (!queryIdStats[queryLineId]) {
                    queryIdStats[queryLineId] = 0;
                }
                queryIdStats[queryLineId]++;
            }
        });
        
        if (Object.keys(queryIdStats).length > 0) {
            console.log(`查询ID统计:`, queryIdStats);
        }

        // 验证车牌数据的有效性
        const validBusLicenses = busLicenses.filter(bus => {
            // 基本数据验证
            if (!bus.busId) {
                return false;
            }
            
            // 如果车牌数据包含验证信息，进行严格验证
            if (bus._verifiedLineId || bus._verifiedLineName) {
                if (bus._verifiedLineId !== lineId) {
                    console.warn(`车牌 ${bus.busId} 的验证线路ID不匹配，期望: ${lineId}, 实际: ${bus._verifiedLineId}`);
                    return false;
                }
                
                if (bus._verifiedLineName !== lineName) {
                    console.warn(`车牌 ${bus.busId} 的验证线路名称不匹配，期望: ${lineName}, 实际: ${bus._verifiedLineName}`);
                    return false;
                }
                
                // 检查查询时间戳，防止使用过期数据
                const queryTime = bus._queryTimestamp || 0;
                const timeDiff = Date.now() - queryTime;
                if (timeDiff > 30000) { // 30秒内的数据才有效
                    console.warn(`车牌 ${bus.busId} 的查询时间过期，时间差: ${timeDiff}ms，查询ID: ${bus._queryId || 'unknown'}`);
                    return false;
                }
                
                // 检查查询ID的有效性
                if (bus._queryId) {
                    const queryIdParts = bus._queryId.split('_');
                    if (queryIdParts.length >= 2) {
                        const queryLineId = queryIdParts[0];
                        const queryTimestamp = parseInt(queryIdParts[1]);
                        
                        // 验证查询ID中的线路ID是否匹配
                        if (queryLineId !== lineId) {
                            console.warn(`车牌 ${bus.busId} 的查询ID中线路ID不匹配，期望: ${lineId}, 查询ID中: ${queryLineId}`);
                            return false;
                        }
                        
                        // 验证查询ID的时间戳是否在合理范围内
                        const queryIdAge = Date.now() - queryTimestamp;
                        if (queryIdAge > 60000) { // 查询ID超过60秒的数据无效
                            console.warn(`车牌 ${bus.busId} 的查询ID过期，年龄: ${queryIdAge}ms，查询ID: ${bus._queryId}`);
                            return false;
                        }
                    }
                }
                
                // 新增：检查最终状态验证数据
                if (bus._finalGlobalLineId && bus._targetLineId) {
                    if (bus._finalGlobalLineId !== bus._targetLineId) {
                        console.error(`车牌 ${bus.busId} 的最终状态验证失败，目标线路: ${bus._targetLineId}, 最终全局线路: ${bus._finalGlobalLineId}`);
                        return false;
                    }
                    
                    if (bus._targetLineId !== lineId) {
                        console.error(`车牌 ${bus.busId} 的目标线路与当前线路不匹配，当前: ${lineId}, 目标: ${bus._targetLineId}`);
                        return false;
                    }
                }
            } else {
                // 如果没有验证信息，检查当前全局线路信息
                if (window.globalLineId !== lineId) {
                    console.warn(`车牌 ${bus.busId} 缺少验证信息且全局线路ID不匹配，跳过`);
                    return false;
                }
            }
            
            return true;
        });

        // 如果没有有效的车牌数据，直接返回
        if (validBusLicenses.length === 0) {
            console.warn(`线路 ${lineName} (${lineId}) 没有有效的车牌数据，跳过添加`);
            console.warn(`  原始数据: ${busLicenses.length} 辆车，过滤后: ${validBusLicenses.length} 辆车`);
            return 0;
        }

        console.log(`线路 ${lineName} (${lineId}) 验证通过 ${validBusLicenses.length} 辆车的数据`);

        // 添加有效的车牌记录（逐条写入以确保持久化）
        for (const bus of validBusLicenses) {
            try {
                const wasAdded = await this.addRecord(bus.busId, lineId, lineName, today, false);
                if (wasAdded) {
                    addedCount++;
                    console.log(`✓ 成功添加车牌 ${bus.busId} 到线路 ${lineName} (查询ID: ${bus._queryId || 'N/A'})`);
                } else {
                    console.log(`- 跳过重复车牌 ${bus.busId} 在线路 ${lineName} (查询ID: ${bus._queryId || 'N/A'})`);
                }
            } catch (err) {
                console.error(`添加车牌 ${bus.busId} 时写入失败:`, err);
            }
        }

        if (addedCount > 0) {
            console.log(`✓ 成功添加 ${addedCount} 条车牌记录到线路 ${lineName} (${lineId})`);
        }
        
        return addedCount;
    }

    showManualAddDialog() {
        // 移除已存在的手动添加窗口
        const existingModal = document.getElementById('manualAddModal');
        if (existingModal) {
            document.body.removeChild(existingModal);
        }

        const modalHTML = `
            <div id="manualAddModal" class="manual-add-modal" style="display: none;">
                <div class="manual-add-content">
                    <div class="manual-add-header">
                        <h2>手动添加车牌</h2>
                        <span class="manual-add-close">&times;</span>
                    </div>
                    <div class="manual-add-body">
                        <div class="manual-add-form">
                            <div class="form-group">
                                <label for="manualBusId">车牌号</label>
                                <input type="text" id="manualBusId" value="苏G" placeholder="请输入车牌号">
                            </div>
                            <div class="form-group">
                                <label for="manualLineName">线路名称（可留空）</label>
                                <input type="text" id="manualLineName" placeholder="请输入线路名称，留空则保存为占位线">
                            </div>
                            <div class="form-actions">
                                <button id="manualAddCancel" class="btn-cancel">取消</button>
                                <button id="manualAddConfirm" class="btn-confirm">添加</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const styleHTML = `
            <style id="manualAddModalStyle">
                .manual-add-modal {
                    display: none;
                    position: fixed;
                    z-index: 1003;
                    left: 0;
                    top: 0;
                    width: 100%;
                    height: 100%;
                    background-color: rgba(0,0,0,0.6);
                    opacity: 0;
                    transition: opacity 0.3s ease-out;
                }

                .manual-add-modal.show {
                    opacity: 1;
                }

                .manual-add-content {
                    background-color: #fefefe;
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%) scale(0.7);
                    border: 0.2vw solid #888;
                    width: 80%;
                    max-width: 60vw;
                    border-radius: 2vw;
                    overflow: hidden;
                    opacity: 0;
                    transition: all 0.3s ease-out;
                }

                .manual-add-modal.show .manual-add-content {
                    transform: translate(-50%, -50%) scale(1);
                    opacity: 1;
                }

                .manual-add-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 4vw;
                    background-color: #f5f5f5;
                    border-bottom: 0.2vw solid #ddd;
                }

                .manual-add-header h2 {
                    margin: 0;
                    font-size: 4.5vw;
                    font-family: 'FZH', sans-serif;
                    color: #333;
                }

                .manual-add-close {
                    color: #aaa;
                    font-size: 6vw;
                    font-weight: bold;
                    cursor: pointer;
                }

                .manual-add-close:hover {
                    color: black;
                }

                .manual-add-body {
                    padding: 5vw;
                }

                .form-group {
                    margin-bottom: 4vw;
                }

                .form-group label {
                    display: block;
                    margin-bottom: 1.5vw;
                    font-size: 3.5vw;
                    font-family: 'FZH', sans-serif;
                    color: #333;
                    font-weight: bold;
                }

                .form-group input {
                    width: 100%;
                    padding: 2.5vw;
                    border: 0.2vw solid #ddd;
                    border-radius: 1vw;
                    font-size: 4vw;
                    font-family: 'FZH', sans-serif;
                    box-sizing: border-box;
                }

                .form-group input:focus {
                    outline: none;
                    border-color: #2196F3;
                    box-shadow: 0 0 0 0.2vw rgba(33, 150, 243, 0.2);
                }

                .form-actions {
                    display: flex;
                    justify-content: flex-end;
                    gap: 3vw;
                    margin-top: 5vw;
                }

                .form-actions button {
                    padding: 2.5vw 5vw;
                    border: none;
                    border-radius: 1vw;
                    cursor: pointer;
                    font-size: 3.5vw;
                    font-family: 'FZH', sans-serif;
                    transition: background-color 0.3s ease;
                }

                .btn-cancel {
                    background-color: #f5f5f5;
                    color: #666;
                }

                .btn-cancel:hover {
                    background-color: #e0e0e0;
                }

                .btn-confirm {
                    background-color: #4CAF50;
                    color: white;
                }

                .btn-confirm:hover {
                    background-color: #45a049;
                }

                @media (max-width: 768px) {
                    .manual-add-content {
                        width: 90%;
                        max-width: 90vw;
                        margin: 10% auto;
                    }

                    .form-group input {
                        font-size: 4.5vw;
                    }

                    .form-actions button {
                        font-size: 4vw;
                        padding: 3vw 6vw;
                    }
                }
            </style>
        `;

        // 添加样式和HTML到页面
        document.head.insertAdjacentHTML('beforeend', styleHTML);
        document.body.insertAdjacentHTML('beforeend', modalHTML);

        // 绑定事件
        this.bindManualAddEvents();

        // 显示模态窗口
        const modal = document.getElementById('manualAddModal');
        modal.style.display = 'block';
        modal.offsetHeight; // 强制重排
        modal.classList.add('show');
    }

    bindManualAddEvents() {
        const modal = document.getElementById('manualAddModal');
        const closeBtn = document.querySelector('.manual-add-close');
        const cancelBtn = document.getElementById('manualAddCancel');
        const confirmBtn = document.getElementById('manualAddConfirm');
        const busIdInput = document.getElementById('manualBusId');
        const lineNameInput = document.getElementById('manualLineName');

        // 关闭按钮
        closeBtn.addEventListener('click', () => this.closeManualAddDialog());

        // 取消按钮
        cancelBtn.addEventListener('click', () => this.closeManualAddDialog());

        // 点击背景关闭
        modal.addEventListener('click', (e) => {
            if (e.target === modal) this.closeManualAddDialog();
        });

        // 添加按钮
        confirmBtn.addEventListener('click', () => this.performManualAdd());

        // 回车键快捷添加
        const handleEnterKey = (e) => {
            if (e.key === 'Enter') {
                this.performManualAdd();
            }
        };
        busIdInput.addEventListener('keypress', handleEnterKey);
        lineNameInput.addEventListener('keypress', handleEnterKey);

        // 自动聚焦到车牌输入框并选中"苏G"后的位置
        setTimeout(() => {
            busIdInput.focus();
            busIdInput.setSelectionRange(busIdInput.value.length, busIdInput.value.length);
        }, 100);
    }

    closeManualAddDialog() {
        const modal = document.getElementById('manualAddModal');
        if (modal) {
            modal.classList.remove('show');
            setTimeout(() => {
                if (modal && modal.parentNode) {
                    document.body.removeChild(modal);
                }
                // 移除样式
                const styleElement = document.getElementById('manualAddModalStyle');
                if (styleElement && styleElement.parentNode) {
                    document.head.removeChild(styleElement);
                }
            }, 300);
        }
    }

    async performManualAdd() {
        const busIdInput = document.getElementById('manualBusId');
        const lineNameInput = document.getElementById('manualLineName');
        let busId = busIdInput.value.trim();
        const lineName = lineNameInput.value.trim();
        // 自动转为大写
        busId = busId.toUpperCase();
        // 验证车牌号
        if (!busId) {
            await this.showCustomAlert('输入错误', '请输入车牌号');
            busIdInput.focus();
            return;
        }
        // 车牌格式验证
        if (!this.validateLicensePlate(busId)) {
            await this.showCustomAlert('格式错误', '请输入正确的车牌格式，如：苏G12345 或 苏G1234A');
            busIdInput.focus();
            return;
        }
        // 线路名称可以为空，空时将保存为"占位线"
        const finalLineName = lineName || '占位线';

        // 检查是否已存在相同的记录
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const exists = busRecordsManager.records.some(r => 
            r.busId === busId && 
            r.lineName === finalLineName && 
            r.date === today
        );

        if (exists) {
            const confirmed = await this.showCustomConfirm(
                '记录已存在',
                `车牌 ${busId} 在线路 ${finalLineName} 今日已有记录，是否仍要添加？`,
                '继续添加',
                '取消'
            );
            
            if (!confirmed) {
                return;
            }
        }

        // 添加记录（标记为手动添加）
        await busRecordsManager.addRecord(busId, null, lineName, null, true);
        
        // 清除缓存
        this.clearCache();
        
        // 关闭添加对话框
        this.closeManualAddDialog();
        
        // 刷新主界面显示
        this.updateStatistics();
        this.loadRecords();
        
        // 显示成功提示
        await this.showCustomAlert('添加成功', `车牌 ${busId} 已成功添加到线路 ${finalLineName}`);
        
        // 检查是否有车辆历史记录窗口打开
        const historyModal = document.getElementById('busHistoryModal');
        if (historyModal && historyModal.style.display !== 'none') {
            // 如果历史记录窗口打开，刷新历史记录
            const history = busRecordsManager.getBusHistory(busId);
            const vehicleType = busRecordsManager.getVehicleType(busId);
            
            // 更新历史记录列表
            const historyList = document.querySelector('.history-list');
            if (historyList) {
                historyList.innerHTML = this.generateHistoryListHTML(history);
            }
        } else {
            // 如果没有历史记录窗口打开，直接打开该车牌的详情页
            this.showBusHistory(busId);
        }
    }

    // 车牌格式验证
    validateLicensePlate(plate) {
        // 统一转为大写
        plate = plate.toUpperCase();
        // 中国车牌格式验证
        // 普通车牌：省份简称 + 地区代码 + 5位数字或字母
        // 新能源车牌：省份简称 + 地区代码 + 6位数字或字母
        const normalPattern = /^[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领A-Z]{1}[A-Z]{1}[A-Z0-9]{5}$/;
        const newEnergyPattern = /^[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领A-Z]{1}[A-Z]{1}[A-Z0-9]{6}$/;
        return normalPattern.test(plate) || newEnergyPattern.test(plate);
    }

    // 为指定车牌显示添加记录对话框
    showAddRecordForBus(busId) {
        // 移除已存在的手动添加窗口
        const existingModal = document.getElementById('manualAddModal');
        if (existingModal) {
            document.body.removeChild(existingModal);
        }

        const modalHTML = `
            <div id="manualAddModal" class="manual-add-modal" style="display: none;">
                <div class="manual-add-content">
                    <div class="manual-add-header">
                        <h2>为车辆 ${busId} 添加记录</h2>
                        <span class="manual-add-close">&times;</span>
                    </div>
                    <div class="manual-add-body">
                        <div class="manual-add-form">
                            <div class="form-group">
                                <label for="manualBusId">车牌号</label>
                                <input type="text" id="manualBusId" value="${busId}" readonly style="background-color: #f5f5f5; color: #666;">
                            </div>
                            <div class="form-group">
                                <label for="manualLineName">线路名称（可留空）</label>
                                <input type="text" id="manualLineName" placeholder="请输入线路名称，留空则保存为占位线">
                            </div>
                            <div class="form-actions">
                                <button id="manualAddCancel" class="btn-cancel">取消</button>
                                <button id="manualAddConfirm" class="btn-confirm">添加</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const styleHTML = `
            <style id="manualAddModalStyle">
                .manual-add-modal {
                    display: none;
                    position: fixed;
                    z-index: 1004;
                    left: 0;
                    top: 0;
                    width: 100%;
                    height: 100%;
                    background-color: rgba(0,0,0,0.6);
                    opacity: 0;
                    transition: opacity 0.3s ease-out;
                }

                .manual-add-modal.show {
                    opacity: 1;
                }

                .manual-add-content {
                    background-color: #fefefe;
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%) scale(0.7);
                    border: 0.2vw solid #888;
                    width: 80%;
                    max-width: 60vw;
                    border-radius: 2vw;
                    overflow: hidden;
                    opacity: 0;
                    transition: all 0.3s ease-out;
                }

                .manual-add-modal.show .manual-add-content {
                    transform: translate(-50%, -50%) scale(1);
                    opacity: 1;
                }

                .manual-add-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 4vw;
                    background-color: #f5f5f5;
                    border-bottom: 0.2vw solid #ddd;
                }

                .manual-add-header h2 {
                    margin: 0;
                    font-size: 4.5vw;
                    font-family: 'FZH', sans-serif;
                    color: #333;
                }

                .manual-add-close {
                    color: #aaa;
                    font-size: 6vw;
                    font-weight: bold;
                    cursor: pointer;
                }

                .manual-add-close:hover {
                    color: black;
                }

                .manual-add-body {
                    padding: 5vw;
                }

                .form-group {
                    margin-bottom: 4vw;
                }

                .form-group label {
                    display: block;
                    margin-bottom: 1.5vw;
                    font-size: 3.5vw;
                    font-family: 'FZH', sans-serif;
                    color: #333;
                    font-weight: bold;
                }

                .form-group input {
                    width: 100%;
                    padding: 2.5vw;
                    border: 0.2vw solid #ddd;
                    border-radius: 1vw;
                    font-size: 4vw;
                    font-family: 'FZH', sans-serif;
                    box-sizing: border-box;
                }

                .form-group input:focus {
                    outline: none;
                    border-color: #2196F3;
                    box-shadow: 0 0 0 0.2vw rgba(33, 150, 243, 0.2);
                }

                .form-group input[readonly] {
                    background-color: #f5f5f5;
                    color: #666;
                    cursor: not-allowed;
                }

                .form-actions {
                    display: flex;
                    justify-content: flex-end;
                    gap: 3vw;
                    margin-top: 5vw;
                }

                .form-actions button {
                    padding: 2.5vw 5vw;
                    border: none;
                    border-radius: 1vw;
                    cursor: pointer;
                    font-size: 3.5vw;
                    font-family: 'FZH', sans-serif;
                    transition: background-color 0.3s ease;
                }

                .btn-cancel {
                    background-color: #f5f5f5;
                    color: #666;
                }

                .btn-cancel:hover {
                    background-color: #e0e0e0;
                }

                .btn-confirm {
                    background-color: #4CAF50;
                    color: white;
                }

                .btn-confirm:hover {
                    background-color: #45a049;
                }

                @media (max-width: 768px) {
                    .manual-add-content {
                        width: 90%;
                        max-width: 90vw;
                        margin: 10% auto;
                    }

                    .form-group input {
                        font-size: 4.5vw;
                    }

                    .form-actions button {
                        font-size: 4vw;
                        padding: 3vw 6vw;
                    }
                }
            </style>
        `;

        // 添加样式和HTML到页面
        document.head.insertAdjacentHTML('beforeend', styleHTML);
        document.body.insertAdjacentHTML('beforeend', modalHTML);

        // 绑定事件（复用现有的绑定方法）
        this.bindManualAddEvents();

        // 显示模态窗口
        const modal = document.getElementById('manualAddModal');
        modal.style.display = 'block';
        modal.offsetHeight; // 强制重排
        modal.classList.add('show');

        // 自动聚焦到线路输入框
        setTimeout(() => {
            const lineNameInput = document.getElementById('manualLineName');
            lineNameInput.focus();
        }, 100);
    }

    // 显示批量添加对话框
    showBatchAddDialog() {
        // 移除已存在的批量添加窗口
        const existingModal = document.getElementById('batchAddModal');
        if (existingModal) {
            document.body.removeChild(existingModal);
        }

        const modalHTML = `
            <div id="batchAddModal" class="batch-add-modal" style="display: none;">
                <div class="batch-add-content">
                    <div class="batch-add-header">
                        <h2>批量添加车辆记录</h2>
                        <span class="batch-add-close">&times;</span>
                    </div>
                    <div class="batch-add-body">
                        <div class="batch-add-form">
                            <div class="form-group">
                                <label for="batchLineName">线路名称（可留空）</label>
                                <input type="text" id="batchLineName" placeholder="请输入线路名称，留空则保存为占位线">
                            </div>
                            <div class="form-group">
                                <label for="batchBusIds">车牌号列表（每行一个）</label>
                                <textarea id="batchBusIds" rows="8" placeholder="请输入车牌号，每行一个&#10;支持格式：&#10;12345（自动补全为苏G12345）&#10;1234A（自动补全为苏G1234A）&#10;苏G12345（完整车牌）&#10;G12345（自动补全省份为苏G12345）"></textarea>
                            </div>
                            <div class="form-actions">
                                <button id="batchAddCancel" class="btn-cancel">取消</button>
                                <button id="batchAddConfirm" class="btn-confirm">批量添加</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const styleHTML = `
            <style id="batchAddModalStyle">
                .batch-add-modal {
                    display: none;
                    position: fixed;
                    z-index: 1003;
                    left: 0;
                    top: 0;
                    width: 100%;
                    height: 100%;
                    background-color: rgba(0,0,0,0.6);
                    opacity: 0;
                    transition: opacity 0.3s ease-out;
                }

                .batch-add-modal.show {
                    opacity: 1;
                }

                .batch-add-content {
                    background-color: #fefefe;
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%) scale(0.7);
                    border: 0.2vw solid #888;
                    width: 85%;
                    max-width: 70vw;
                    border-radius: 2vw;
                    overflow: hidden;
                    opacity: 0;
                    transition: all 0.3s ease-out;
                }

                .batch-add-modal.show .batch-add-content {
                    transform: translate(-50%, -50%) scale(1);
                    opacity: 1;
                }

                .batch-add-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 4vw;
                    background-color: #f5f5f5;
                    border-bottom: 0.2vw solid #ddd;
                }

                .batch-add-header h2 {
                    margin: 0;
                    font-size: 4.5vw;
                    font-family: 'FZH', sans-serif;
                    color: #333;
                }

                .batch-add-close {
                    color: #aaa;
                    font-size: 6vw;
                    font-weight: bold;
                    cursor: pointer;
                }

                .batch-add-close:hover {
                    color: black;
                }

                .batch-add-body {
                    padding: 5vw;
                }

                .batch-add-form .form-group {
                    margin-bottom: 4vw;
                }

                .batch-add-form .form-group label {
                    display: block;
                    margin-bottom: 1.5vw;
                    font-size: 3.5vw;
                    font-family: 'FZH', sans-serif;
                    color: #333;
                    font-weight: bold;
                }

                .batch-add-form .form-group input {
                    width: 100%;
                    padding: 2.5vw;
                    border: 0.2vw solid #ddd;
                    border-radius: 1vw;
                    font-size: 4vw;
                    font-family: 'FZH', sans-serif;
                    box-sizing: border-box;
                }

                .batch-add-form .form-group textarea {
                    width: 100%;
                    padding: 2.5vw;
                    border: 0.2vw solid #ddd;
                    border-radius: 1vw;
                    font-size: 3.5vw;
                    font-family: 'FZH', sans-serif;
                    box-sizing: border-box;
                    resize: none;
                    min-height: calc(var(--app-vh, 100vh) * 0.2);
                    line-height: 1.5;
                }

                .batch-add-form .form-group input:focus,
                .batch-add-form .form-group textarea:focus {
                    outline: none;
                    border-color: #2196F3;
                    box-shadow: 0 0 0 0.2vw rgba(33, 150, 243, 0.2);
                }

                .batch-add-form .form-actions {
                    display: flex;
                    justify-content: flex-end;
                    gap: 3vw;
                    margin-top: 5vw;
                }

                .batch-add-form .form-actions button {
                    padding: 2.5vw 5vw;
                    border: none;
                    border-radius: 1vw;
                    cursor: pointer;
                    font-size: 3.5vw;
                    font-family: 'FZH', sans-serif;
                    transition: background-color 0.3s ease;
                }

                .batch-add-form .btn-cancel {
                    background-color: #f5f5f5;
                    color: #666;
                }

                .batch-add-form .btn-cancel:hover {
                    background-color: #e0e0e0;
                }

                .batch-add-form .btn-confirm {
                    background-color: #2196F3;
                    color: white;
                }

                .batch-add-form .btn-confirm:hover {
                    background-color: #1976D2;
                }

                @media (max-width: 768px) {
                    .batch-add-content {
                        width: 95%;
                        max-width: 95vw;
                        margin: 5% auto;
                    }

                    .batch-add-form .form-group input,
                    .batch-add-form .form-group textarea {
                        font-size: 4.5vw;
                    }

                    .batch-add-form .form-actions button {
                        font-size: 4vw;
                        padding: 3vw 6vw;
                    }
                }
            </style>
        `;

        // 添加样式和HTML到页面
        document.head.insertAdjacentHTML('beforeend', styleHTML);
        document.body.insertAdjacentHTML('beforeend', modalHTML);

        // 绑定事件
        this.bindBatchAddEvents();

        // 显示模态窗口
        const modal = document.getElementById('batchAddModal');
        modal.style.display = 'block';
        modal.offsetHeight; // 强制重排
        modal.classList.add('show');

        // 自动聚焦到线路输入框
        setTimeout(() => {
            const lineNameInput = document.getElementById('batchLineName');
            lineNameInput.focus();
        }, 100);
    }

    // 绑定批量添加事件
    bindBatchAddEvents() {
        const modal = document.getElementById('batchAddModal');
        const closeBtn = document.querySelector('.batch-add-close');
        const cancelBtn = document.getElementById('batchAddCancel');
        const confirmBtn = document.getElementById('batchAddConfirm');
        const lineNameInput = document.getElementById('batchLineName');
        const busIdsTextarea = document.getElementById('batchBusIds');

        // 关闭按钮
        closeBtn.addEventListener('click', () => this.closeBatchAddDialog());

        // 取消按钮
        cancelBtn.addEventListener('click', () => this.closeBatchAddDialog());

        // 点击背景关闭
        modal.addEventListener('click', (e) => {
            if (e.target === modal) this.closeBatchAddDialog();
        });

        // 批量添加按钮
        confirmBtn.addEventListener('click', () => this.performBatchAdd());

        // 回车键快捷添加（仅在线路名称输入框中）
        lineNameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.performBatchAdd();
            }
        });
    }

    // 关闭批量添加对话框
    closeBatchAddDialog() {
        const modal = document.getElementById('batchAddModal');
        if (modal) {
            modal.classList.remove('show');
            setTimeout(() => {
                if (modal && modal.parentNode) {
                    document.body.removeChild(modal);
                }
                // 移除样式
                const styleElement = document.getElementById('batchAddModalStyle');
                if (styleElement && styleElement.parentNode) {
                    document.head.removeChild(styleElement);
                }
            }, 300);
        }
    }

    // 执行批量添加
    async performBatchAdd() {
        const lineNameInput = document.getElementById('batchLineName');
        const busIdsTextarea = document.getElementById('batchBusIds');
        const lineName = lineNameInput.value.trim();
        const busIdsText = busIdsTextarea.value.trim();
        // 验证车牌输入
        if (!busIdsText) {
            await this.showCustomAlert('输入错误', '请输入车牌号列表');
            busIdsTextarea.focus();
            return;
        }
        // 处理车牌列表
        const busIdLines = busIdsText.split('\n').map(line => line.trim()).filter(line => line.length > 0);
        if (busIdLines.length === 0) {
            await this.showCustomAlert('输入错误', '请输入有效的车牌号');
            busIdsTextarea.focus();
            return;
        }
        // 补全和验证车牌号
        const processedBusIds = [];
        const invalidBusIds = [];
        for (let i = 0; i < busIdLines.length; i++) {
            const line = busIdLines[i];
            // 自动转为大写
            const completedBusId = this.completeLicensePlate(line.toUpperCase());
            if (completedBusId && this.validateLicensePlate(completedBusId)) {
                processedBusIds.push(completedBusId);
            } else {
                invalidBusIds.push(`第${i+1}行: ${line}`);
            }
        }
        // 检查是否有无效车牌
        if (invalidBusIds.length > 0) {
            const confirmed = await this.showCustomConfirm(
                '车牌格式错误',
                `以下车牌格式无效：\n${invalidBusIds.join('\n')}\n\n是否继续添加有效的车牌？`,
                '继续',
                '取消'
            );
            
            if (!confirmed) {
                return;
            }
        }

        if (processedBusIds.length === 0) {
            await this.showCustomAlert('添加失败', '没有有效的车牌号可以添加');
            return;
        }

        // 执行批量添加
        const finalLineName = lineName || '占位线';
        let addedCount = 0;
        let skippedCount = 0;

        // 使用本地时间获取今日日期
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

        for (const busId of processedBusIds) {
            // 检查是否已存在相同记录
            const exists = busRecordsManager.records.some(r => 
                r.busId === busId && 
                r.lineName === finalLineName && 
                r.date === today
            );

            if (!exists) {
                await busRecordsManager.addRecord(busId, null, lineName, null, true);
                addedCount++;
            } else {
                skippedCount++;
            }
        }

        // 关闭对话框
        this.closeBatchAddDialog();

        // 清除缓存
        this.clearCache();

        // 刷新主界面
        this.updateStatistics();
        this.loadRecords();

        // 显示结果
        let message = `批量添加完成！\n成功添加: ${addedCount} 条记录`;
        if (skippedCount > 0) {
            message += `\n跳过重复: ${skippedCount} 条记录`;
        }
        if (invalidBusIds.length > 0) {
            message += `\n格式错误: ${invalidBusIds.length} 条记录`;
        }

        await this.showCustomAlert('批量添加结果', message);
    }

    // 补全车牌号
    completeLicensePlate(input) {
        if (!input || typeof input !== 'string') return null;
        const trimmed = input.trim().toUpperCase();
        // 如果已经是完整格式，直接返回
        if (/^[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领A-Z]{1}[A-Z]{1}[A-Z0-9]{5,6}$/.test(trimmed)) {
            return trimmed;
        }
        // 如果只有地区代码+号码（如G12345），补全省份
        if (/^[A-Z]{1}[A-Z0-9]{5,6}$/.test(trimmed)) {
            return '苏' + trimmed;
        }
        // 如果只有号码（如12345、1234A），补全苏G
        if (/^[A-Z0-9]{5,6}$/.test(trimmed)) {
            return '苏G' + trimmed;
        }
        // 其他情况返回null，表示无法补全
        return null;
    }

    // 显示服务器导出对话框
    showServerExportDialog() {
        // 移除已存在的导出窗口
        const existingModal = document.getElementById('serverExportModal');
        if (existingModal) {
            document.body.removeChild(existingModal);
        }

        const modalHTML = `
            <div id="serverExportModal" class="export-options-modal" style="display: none;">
                <div class="export-options-content">
                    <div class="export-options-header">
                        <h2>导出数据到服务器</h2>
                        <span class="export-options-close">&times;</span>
                    </div>
                    <div class="export-options-body">
                        <div class="server-config">
                            <h4>服务器配置</h4>
                            <div class="server-input-group">
                                <label for="serverIp">服务器地址：</label>
                                <input type="text" id="serverIp" placeholder="例如：192.168.1.100:8888 或 example.com:8888" value="">
                        </div>
                            <div class="server-input-group">
                                <label for="serverPort">端口号：</label>
                                <input type="number" id="serverPort" placeholder="例如：8080" value="8080" min="1" max="65535">
                        </div>
                            <div class="server-input-group">
                                <label for="exportEndpoint">导出接口：</label>
                                <input type="text" id="exportEndpoint" placeholder="例如：/api/export" value="/api/export">
                        </div>
                            <div class="server-test">
                                <button id="testConnection" class="test-btn">测试连接</button>
                                <span id="connectionStatus" class="connection-status"></span>
                            </div>
                        </div>
                        
                        <div class="export-options-actions">
                            <button id="exportOptionsCancel" class="cancel-btn">取消</button>
                            <button id="exportOptionsConfirm" class="confirm-btn" disabled>开始导出</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const styleHTML = `
            <style id="exportOptionsModalStyle">
                .export-options-modal {
                    display: none;
                    position: fixed;
                    z-index: 1003;
                    left: 0;
                    top: 0;
                    width: 100%;
                    height: 100%;
                    background-color: rgba(0,0,0,0.6);
                    opacity: 0;
                    transition: opacity 0.3s ease-out;
                }

                .export-options-modal.show {
                    opacity: 1;
                }

                .export-options-content {
                    background-color: #fefefe;
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%) scale(0.7);
                    border: 0.2vw solid #888;
                    width: 90%;
                    max-width: 90vw;
                    max-height: calc(var(--app-vh, 100vh) * 0.85);
                    border-radius: 2vw;
                    overflow-y: auto;
                    overflow-x: hidden;
                    opacity: 0;
                    transition: all 0.3s ease-out;
                    display: flex;
                    flex-direction: column;
                }

                .export-options-modal.show .export-options-content {
                    transform: translate(-50%, -50%) scale(1);
                    opacity: 1;
                }

                .export-options-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 4vw;
                    background-color: #f5f5f5;
                    border-bottom: 0.2vw solid #ddd;
                }

                .export-options-header h2 {
                    margin: 0;
                    font-size: 5vw;
                    font-weight: bold;
                    color: #333;
                }

                .export-options-close {
                    color: #aaa;
                    font-size: 7vw;
                    font-weight: bold;
                    cursor: pointer;
                }

                .export-options-close:hover,
                .export-options-close:focus {
                    color: #000;
                    text-decoration: none;
                }

                .export-options-body {
                    padding: 4vw;
                }


                .server-config {
                    padding: 3vw;
                    border: 0.2vw solid #ddd;
                    border-radius: 1.5vw;
                    background-color: #f9f9f9;
                    margin-bottom: 4vw;
                }

                .server-config h4 {
                    margin: 0 0 3vw 0;
                    font-size: 4vw;
                    color: #333;
                }

                .server-input-group {
                    margin-bottom: 3vw;
                }

                .server-input-group label {
                    display: block;
                    margin-bottom: 1vw;
                    font-size: 3.5vw;
                    color: #333;
                    font-weight: bold;
                }

                .server-input-group input {
                    width: 100%;
                    padding: 2.5vw;
                    border: 0.2vw solid #ddd;
                    border-radius: 1vw;
                    font-size: 3.5vw;
                    box-sizing: border-box;
                }

                .server-input-group input:focus {
                    border-color: #2196F3;
                    outline: none;
                }

                .server-test {
                    display: flex;
                    align-items: center;
                    gap: 2vw;
                    margin-top: 3vw;
                }

                .test-btn {
                    padding: 2.2vw 4vw;
                    background-color: #2196F3;
                    color: white;
                    border: none;
                    border-radius: 1vw;
                    font-size: 3.5vw;
                    line-height: 1.2;
                    cursor: pointer;
                    box-sizing: border-box;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    overflow: hidden;
                }

                .test-btn:hover {
                    background-color: #1976D2;
                }

                .test-btn:disabled {
                    background-color: #ccc;
                    cursor: not-allowed;
                }

                .connection-status {
                    font-size: 3vw;
                    font-weight: bold;
                }

                .connection-status.success {
                    color: #4CAF50;
                }

                .connection-status.error {
                    color: #f44336;
                }

                .connection-status.testing {
                    color: #FF9800;
                }

                .export-options-actions {
                    display: flex;
                    gap: 3vw;
                    justify-content: flex-end;
                }

                .export-options-actions button {
                    padding: 2.2vw 4.5vw;
                    border: none;
                    border-radius: 1.2vw;
                    font-size: 3.6vw;
                    line-height: 1.2;
                    cursor: pointer;
                    box-sizing: border-box;
                    transition: background-color 0.3s ease;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    overflow: hidden;
                }

                .cancel-btn {
                    background-color: #f44336;
                    color: white;
                }

                .cancel-btn:hover {
                    background-color: #d32f2f;
                }

                .confirm-btn {
                    background-color: #4CAF50;
                    color: white;
                }

                .confirm-btn:hover:not(:disabled) {
                    background-color: #45a049;
                }

                .confirm-btn:disabled {
                    background-color: #ccc;
                    cursor: not-allowed;
                }

                /* 滚动条样式美化 */
                .import-content::-webkit-scrollbar,
                .export-options-content::-webkit-scrollbar {
                    width: 1vw;
                }

                .import-content::-webkit-scrollbar-track,
                .export-options-content::-webkit-scrollbar-track {
                    background: #f1f1f1;
                    border-radius: 1vw;
                }

                .import-content::-webkit-scrollbar-thumb,
                .export-options-content::-webkit-scrollbar-thumb {
                    background: #888;
                    border-radius: 1vw;
                }

                .import-content::-webkit-scrollbar-thumb:hover,
                .export-options-content::-webkit-scrollbar-thumb:hover {
                    background: #555;
                }

                @media (max-width: 768px) {
                    .export-options-content {
                        margin: 2% auto;
                        width: 95%;
                        max-height: calc(var(--app-vh, 100vh) * 0.95);
                    }
                    
                    .export-options-actions {
                        flex-direction: column;
                        gap: 3vw;
                    }

                    .export-options-actions button {
                        width: 100%;
                        padding: 4vw;
                        font-size: 4vw;
                    }
                }
            </style>
        `;

        // 插入HTML和样式
        document.head.insertAdjacentHTML('beforeend', styleHTML);
        document.body.insertAdjacentHTML('beforeend', modalHTML);

        const modal = document.getElementById('serverExportModal');
        const closeBtn = modal.querySelector('.export-options-close');
        const cancelBtn = document.getElementById('exportOptionsCancel');
        const confirmBtn = document.getElementById('exportOptionsConfirm');
        const testConnectionBtn = document.getElementById('testConnection');
        const connectionStatus = document.getElementById('connectionStatus');

        // 从localStorage读取服务器配置
        const savedServerConfig = localStorage.getItem('busRecords_serverConfig');
        if (savedServerConfig) {
            try {
                const config = JSON.parse(savedServerConfig);
                document.getElementById('serverIp').value = config.ip || '';
                document.getElementById('serverPort').value = config.port || '8080';
                document.getElementById('exportEndpoint').value = config.endpoint || '/api/export';
            } catch (e) {
                console.warn('读取服务器配置失败:', e);
            }
        }

        // 测试连接
        testConnectionBtn.addEventListener('click', () => {
            this.testServerConnection();
        });

        // 输入验证
        ['serverIp', 'serverPort', 'exportEndpoint'].forEach(id => {
            document.getElementById(id).addEventListener('input', () => {
                this.validateServerExportOptions();
            });
        });

        // 关闭模态框
        const closeModal = () => {
            modal.classList.remove('show');
            setTimeout(() => {
                if (modal.parentNode) {
                    document.body.removeChild(modal);
                }
                const style = document.getElementById('exportOptionsModalStyle');
                if (style && style.parentNode) {
                    style.parentNode.removeChild(style);
                }
            }, 300);
        };

        closeBtn.addEventListener('click', closeModal);
        cancelBtn.addEventListener('click', closeModal);

        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal();
            }
        });

        // 确认导出 - 只有服务器导出
        confirmBtn.addEventListener('click', () => {
            const serverConfig = {
                ip: document.getElementById('serverIp').value.trim(),
                port: document.getElementById('serverPort').value.trim(),
                endpoint: document.getElementById('exportEndpoint').value.trim()
            };
            
            // 保存服务器配置
            localStorage.setItem('busRecords_serverConfig', JSON.stringify(serverConfig));
            
            closeModal();
            this.exportToServer(serverConfig);
        });

        // 显示模态框
        modal.style.display = 'block';
        setTimeout(() => {
        modal.classList.add('show');
        }, 10);

        // 验证函数
        this.validateServerExportOptions = () => {
            const ip = document.getElementById('serverIp').value.trim();
            const port = document.getElementById('serverPort').value.trim();
            const endpoint = document.getElementById('exportEndpoint').value.trim();
            
            const isValid = ip && port && endpoint && 
                           this.isValidServerAddress(ip) &&
                           parseInt(port) > 0 && parseInt(port) <= 65535;
            
            confirmBtn.disabled = !isValid;
        };

        // 初始验证
        this.validateServerExportOptions();
    }







    // 测试服务器连接
    testServerConnection() {
        const ip = document.getElementById('serverIp').value.trim();
        const port = document.getElementById('serverPort').value.trim();
        const connectionStatus = document.getElementById('connectionStatus');
        const testBtn = document.getElementById('testConnection');
        
        if (!ip || !port) {
            connectionStatus.textContent = '请输入服务器地址和端口';
            connectionStatus.className = 'connection-status error';
            return;
        }
        
        // 显示测试状态
        connectionStatus.textContent = '测试连接中...';
        connectionStatus.className = 'connection-status testing';
        testBtn.disabled = true;
        
        const testUrl = `http://${ip}:${port}/ping`;
        const timeout = 5000; // 5秒超时
        
        // 创建超时Promise
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('连接超时')), timeout);
        });
        
        // 测试连接
        Promise.race([
            fetch(testUrl, {
                method: 'GET',
                mode: 'cors',
                headers: {
                    'Content-Type': 'application/json'
                }
            }),
            timeoutPromise
        ])
        .then(response => {
            if (response.ok) {
                connectionStatus.textContent = '连接成功！';
                connectionStatus.className = 'connection-status success';
            } else {
                connectionStatus.textContent = `连接失败 (${response.status})`;
                connectionStatus.className = 'connection-status error';
            }
        })
        .catch(error => {
            console.warn('服务器连接测试失败:', error);
            connectionStatus.textContent = '连接失败，请检查服务器配置';
            connectionStatus.className = 'connection-status error';
        })
        .finally(() => {
            testBtn.disabled = false;
        });
    }

    // 导出数据到服务器
    exportToServer(serverConfig) {
        try {
            const records = busRecordsManager.records;
            const statistics = busRecordsManager.getStatistics();
            
            // 显示正在导出的提示
            this.showCustomAlert('正在导出', `正在向服务器导出 ${records.length} 条记录...`, 'info', false);
            
            // 创建导出数据对象
            const exportData = {
                version: "1.0",
                exported_at: new Date().toISOString(),
                device_info: {
                    platform: navigator.platform || 'Unknown',
                    userAgent: navigator.userAgent,
                    appVersion: "1.0.0"
                },
                statistics: statistics,
                records: records,
                record_count: records.length
            };
            
            // 压缩和加密数据
            const compressedData = this.compressAndEncrypt(exportData);
            if (!compressedData) {
                throw new Error('数据压缩失败');
            }
            
            // 发送到服务器
            this.sendToServer(compressedData, serverConfig, records.length)
                .then(() => {
                    // 导出成功
                    this.showCustomAlert('导出成功', 
                        `已成功向服务器导出 ${records.length} 条记录！\n\n` +
                        `服务器：${serverConfig.ip}:${serverConfig.port}\n` +
                        `接口：${serverConfig.endpoint}\n\n` +
                        `数据已保存到远程服务器。`
                    );
                })
                .catch(error => {
                    console.error('服务器导出失败:', error);
                    this.showCustomAlert('导出失败', 
                        `向服务器导出数据时发生错误：\n${error.message}\n\n` +
                        `请检查网络连接和服务器配置。`
                    );
                });
                
            } catch (error) {
            console.error('准备服务器导出数据失败:', error);
            this.showCustomAlert('导出失败', '准备导出数据时发生错误');
        }
    }

    // 发送数据到服务器
    sendToServer(compressedData, serverConfig, recordCount) {
        return new Promise((resolve, reject) => {
            const url = `http://${serverConfig.ip}:${serverConfig.port}${serverConfig.endpoint}`;
            const timeout = 30000; // 30秒超时
            
            // 准备发送的数据
            const payload = {
                timestamp: Date.now(),
                device_id: this.getDeviceId(),
                client_version: '1.0.0',
                device_type: 'mobile',
                data: compressedData,
                record_count: recordCount,
                compression: 'gzip',
                encryption: 'base64'
            };
            
            // 创建超时Promise
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('请求超时，请检查网络连接')), timeout);
            });
            
            // 发送请求
            Promise.race([
                fetch(url, {
                    method: 'POST',
                    mode: 'cors',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                }),
                timeoutPromise
            ])
            .then(response => {
                if (!response.ok) {
                    throw new Error(`服务器响应错误 (${response.status}): ${response.statusText}`);
                }
                return response.json();
            })
            .then(result => {
                console.log('服务器导出成功:', result);
                resolve(result);
            })
            .catch(error => {
                console.error('发送到服务器失败:', error);
                reject(error);
            });
        });
    }

    // 获取设备ID
    getDeviceId() {
        let deviceId = localStorage.getItem('busRecords_deviceId');
        if (!deviceId) {
            // 生成简单的设备ID
            deviceId = 'device_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            localStorage.setItem('busRecords_deviceId', deviceId);
        }
        return deviceId;
    }

    // 从服务器导入数据
    importFromServer(serverConfig) {
        try {
            // 显示正在导入的提示
            this.showCustomAlert('正在导入', '正在从服务器获取数据...', 'info', false);
            
            const url = `http://${serverConfig.ip}:${serverConfig.port}${serverConfig.importEndpoint || '/api/import'}`;
            const timeout = 30000; // 30秒超时
            
            // 创建超时Promise
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('请求超时，请检查网络连接')), timeout);
            });
            
            // 请求参数
            const params = {
                device_id: this.getDeviceId(),
                timestamp: Date.now()
            };
            
            // 发送请求
            Promise.race([
                fetch(url, {
                    method: 'POST',
                    mode: 'cors',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(params)
                }),
                timeoutPromise
            ])
            .then(response => {
                if (!response.ok) {
                    throw new Error(`服务器响应错误 (${response.status}): ${response.statusText}`);
                }
                return response.json();
            })
            .then(result => {
                if (!result.success) {
                    throw new Error(result.message || '服务器返回错误');
                }
                
                // 解压和解密数据
                return this.decryptAndDecompress(result.data);
            })
            .then(importData => {
                if (!importData) {
                    throw new Error('数据解压失败');
                }
                
                // 处理导入数据
                return this.processImportData(importData, 'merge'); // 默认合并模式
            })
            .then(result => {
                // 导入成功
                let message = `已成功从服务器导入数据！\n\n` +
                    `服务器：${serverConfig.ip}:${serverConfig.port}\n` +
                    `新增记录：${result.addedCount}条`;
                
                if (result.skippedCount > 0) {
                    message += `\n跳过重复：${result.skippedCount}条`;
                }
                if (result.errorCount > 0) {
                    message += `\n导入失败：${result.errorCount}条`;
                }
                
                message += `\n总记录数：${busRecordsManager.records.length}条`;
                
                this.showCustomAlert('导入成功', message);
                
            })
            .catch(error => {
                console.error('服务器导入失败:', error);
                this.showCustomAlert('导入失败', 
                    `从服务器导入数据时发生错误：\n${error.message}\n\n` +
                    `请检查网络连接和服务器配置。`
                );
            });
            
        } catch (error) {
            console.error('准备服务器导入数据失败:', error);
            this.showCustomAlert('导入失败', '准备导入数据时发生错误');
        }
    }



    // 显示导入数据对话框
    showImportDialog() {
        // 移除已存在的导入窗口
        const existingModal = document.getElementById('importModal');
        if (existingModal) {
            document.body.removeChild(existingModal);
        }

        const modalHTML = `
            <div id="importModal" class="import-modal" style="display: none;">
                <div class="import-content">
                    <div class="import-header">
                        <h2>导入车牌记录数据</h2>
                        <span class="import-close">&times;</span>
                    </div>
                    <div class="import-body">
                        <div class="import-info">
                            <p>选择导入方式：从本地文件或远程服务器导入车牌记录数据。</p>
                            <p style="color: #f44336;">注意：导入数据将与现有数据合并，相同记录将被跳过。</p>
                        </div>
                        
                        <div class="import-method-selection">
                            <div class="import-method" data-method="local">
                                <div class="method-icon">📁</div>
                                <div class="method-info">
                                    <h3>本地导入</h3>
                                    <p>从本地文件导入数据</p>
                                    <small>适用于本地备份文件</small>
                        </div>
                            </div>
                            <div class="import-method" data-method="server">
                                <div class="method-icon">🌐</div>
                                <div class="method-info">
                                    <h3>服务器导入</h3>
                                    <p>从远程服务器获取数据</p>
                                    <small>适用于数据同步</small>
                                </div>
                            </div>
                        </div>
                        
                        <div id="localImportConfig" class="import-config" style="display: none;">
                            <h4>本地文件导入</h4>
                            <div class="import-file-container">
                                <label for="importFileName">输入文件名：</label>
                                <div class="file-name-input-wrapper">
                                    <input type="text" id="importFileName" placeholder="例如：车牌记录_100条_20240101_1230.json" class="file-name-input">
                                    <button type="button" id="browseFilesBtn" class="browse-files-btn">浏览文件</button>
                                </div>
                                <div class="file-path-info">
                                    <small>文件将从下载目录读取：/storage/emulated/0/Download/</small>
                                </div>
                                <div id="availableFiles" class="available-files" style="display: none;">
                                    <div class="available-files-title">下载目录中的 .json 文件：</div>
                                    <div id="filesList" class="files-list"></div>
                                </div>
                            </div>
                        </div>
                        
                        <div id="serverImportConfig" class="import-config" style="display: none;">
                            <h4>服务器配置</h4>
                            <div class="server-input-group">
                                <label for="importServerIp">服务器地址：</label>
                                <input type="text" id="importServerIp" placeholder="例如：192.168.1.100:8888 或 example.com:8888" value="">
                            </div>
                            <div class="server-input-group">
                                <label for="importServerPort">端口号：</label>
                                <input type="number" id="importServerPort" placeholder="例如：8080" value="8080" min="1" max="65535">
                            </div>
                            <div class="server-input-group">
                                <label for="importEndpoint">导入接口：</label>
                                <input type="text" id="importEndpoint" placeholder="例如：/api/import" value="/api/import">
                            </div>
                            <div class="server-test">
                                <button id="testImportConnection" class="test-btn">测试连接</button>
                                <span id="importConnectionStatus" class="connection-status"></span>
                            </div>
                        </div>
                        
                        <div class="import-note">
                            <span style="color: #666; font-size: 14px;">📝 导入模式：合并添加 - 保留现有数据，添加新记录（自动跳过重复记录）</span>
                        </div>
                        <div class="import-actions">
                            <button id="importCancel" class="cancel-btn">取消</button>
                            <button id="importConfirm" class="confirm-btn" disabled>开始导入</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const styleHTML = `
            <style id="importModalStyle">
                .import-modal {
                    display: none;
                    position: fixed;
                    z-index: 1003;
                    left: 0;
                    top: 0;
                    width: 100%;
                    height: 100%;
                    background-color: rgba(0,0,0,0.6);
                    opacity: 0;
                    transition: opacity 0.3s ease-out;
                }

                .import-modal.show {
                    opacity: 1;
                }

                .import-content {
                    background-color: #fefefe;
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%) scale(0.7);
                    border: 0.2vw solid #888;
                    width: 90%;
                    max-width: 90vw;
                    max-height: calc(var(--app-vh, 100vh) * 0.85);
                    border-radius: 2vw;
                    overflow-y: auto;
                    overflow-x: hidden;
                    opacity: 0;
                    transition: all 0.3s ease-out;
                    display: flex;
                    flex-direction: column;
                }

                .import-modal.show .import-content {
                    transform: translate(-50%, -50%) scale(1);
                    opacity: 1;
                }

                .import-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 4vw;
                    background-color: #f5f5f5;
                    border-bottom: 0.2vw solid #ddd;
                }

                .import-header h2 {
                    margin: 0;
                    font-size: 4.5vw;
                    font-family: 'FZH', sans-serif;
                    color: #333;
                }

                .import-close {
                    color: #aaa;
                    font-size: 6vw;
                    font-weight: bold;
                    cursor: pointer;
                }

                .import-close:hover {
                    color: black;
                }

                .import-body {
                    padding: 4vw;
                }

                .import-info {
                    margin-bottom: 4vw;
                }

                .import-info p {
                    margin: 1.5vw 0;
                    font-size: 3.5vw;
                    font-family: 'FZH', sans-serif;
                    line-height: 1.5;
                }

                .import-file-container {
                    display: flex;
                    flex-direction: column;
                    margin-bottom: 4vw;
                }

                .import-file-container label {
                    font-size: 3.5vw;
                    font-family: 'FZH', sans-serif;
                    margin-bottom: 2vw;
                    color: #333;
                    font-weight: bold;
                }

                .file-name-input-wrapper {
                    display: flex;
                    gap: 2vw;
                    margin-bottom: 2vw;
                }

                .file-name-input {
                    flex: 1;
                    padding: 3vw;
                    border: 0.2vw solid #ddd;
                    border-radius: 1vw;
                    font-size: 3.2vw;
                    font-family: 'FZH', sans-serif;
                    background-color: #fff;
                }

                .file-name-input:focus {
                    outline: none;
                    border-color: #4CAF50;
                    background-color: #f9fff9;
                }

                .browse-files-btn {
                    padding: 2.2vw 4vw;
                    background-color: #2196F3;
                    color: white;
                    border: none;
                    border-radius: 1vw;
                    cursor: pointer;
                    font-size: 3.2vw;
                    line-height: 1.2;
                    font-family: 'FZH', sans-serif;
                    white-space: nowrap;
                    box-sizing: border-box;
                    transition: background-color 0.3s;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    overflow: hidden;
                }

                .browse-files-btn:hover {
                    background-color: #1976D2;
                }

                .file-path-info {
                    margin-bottom: 3vw;
                }

                .file-path-info small {
                    color: #666;
                    font-size: 2.8vw;
                    font-family: 'FZH', sans-serif;
                }

                .available-files {
                    border: 0.2vw solid #ddd;
                    border-radius: 1vw;
                    padding: 3vw;
                    background-color: #f9f9f9;
                    max-height: calc(var(--app-vh, 100vh) * 0.3);
                    overflow-y: auto;
                }

                .available-files-title {
                    font-size: 3vw;
                    font-family: 'FZH', sans-serif;
                    color: #333;
                    margin-bottom: 2vw;
                    font-weight: bold;
                }

                .files-list {
                    display: flex;
                    flex-direction: column;
                    gap: 1vw;
                }

                .file-item {
                    padding: 2vw 3vw;
                    background-color: #fff;
                    border: 0.1vw solid #eee;
                    border-radius: 0.8vw;
                    cursor: pointer;
                    font-size: 2.8vw;
                    font-family: 'FZH', sans-serif;
                    transition: all 0.3s;
                }

                .file-item:hover {
                    background-color: #e3f2fd;
                    border-color: #2196F3;
                }

                .file-item.selected {
                    background-color: #e8f5e8;
                    border-color: #4CAF50;
                    color: #2e7d2e;
                }

                .import-options {
                    margin-bottom: 4vw;
                }

                .import-options label {
                    display: block;
                    margin-bottom: 2vw;
                    font-size: 3.5vw;
                    font-family: 'FZH', sans-serif;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 2vw;
                }

                .import-options input[type="radio"] {
                    width: 3.5vw;
                    height: 3.5vw;
                }

                .import-actions {
                    display: flex;
                    gap: 2vw;
                    justify-content: flex-end;
                }

                .import-actions button {
                    padding: 2.2vw 4vw;
                    border: none;
                    border-radius: 1.2vw;
                    cursor: pointer;
                    font-size: 3.5vw;
                    line-height: 1.2;
                    font-family: 'FZH', sans-serif;
                    box-sizing: border-box;
                    transition: background-color 0.3s;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    overflow: hidden;
                }

                .cancel-btn {
                    background-color: #f44336;
                    color: white;
                }

                .cancel-btn:hover {
                    background-color: #da190b;
                }

                .confirm-btn {
                    background-color: #4CAF50;
                    color: white;
                }

                .confirm-btn:hover:not(:disabled) {
                    background-color: #45a049;
                }

                .confirm-btn:disabled {
                    background-color: #ccc;
                    cursor: not-allowed;
                }

                @media (max-width: 768px) {
                    .import-content {
                        margin: 2% auto;
                        width: 95%;
                        max-height: calc(var(--app-vh, 100vh) * 0.95);
                    }

                    /* 移动端滚动条优化 */
                    .import-content::-webkit-scrollbar,
                    .export-options-content::-webkit-scrollbar {
                        width: 2vw;
                    }
                    
                    .import-file-container {
                        margin-bottom: 4vw;
                    }

                    .file-name-input-wrapper {
                        flex-direction: column;
                        gap: 3vw;
                    }

                    .file-name-input {
                        font-size: 4vw;
                        padding: 4vw;
                    }

                    .browse-files-btn {
                        font-size: 4vw;
                        padding: 4vw;
                        width: 100%;
                    }

                    .file-path-info small {
                        font-size: 3.2vw;
                    }

                    .available-files {
                        max-height: calc(var(--app-vh, 100vh) * 0.25);
                    }

                    .available-files-title {
                        font-size: 3.5vw;
                    }

                    .file-item {
                        font-size: 3.2vw;
                        padding: 3vw 4vw;
                    }
                    
                    .import-actions {
                        flex-direction: column;
                        gap: 3vw;
                    }

                    .import-actions button {
                        width: 100%;
                        padding: 4vw;
                        font-size: 4vw;
                    }
                }

                /* 导入方式选择样式 */
                .import-method-selection {
                    display: flex;
                    gap: 3vw;
                    margin-bottom: 4vw;
                }

                .import-method {
                    flex: 1;
                    padding: 3vw;
                    border: 0.3vw solid #ddd;
                    border-radius: 1.5vw;
                    cursor: pointer;
                    transition: all 0.3s ease;
                    text-align: center;
                }

                .import-method:hover {
                    border-color: #2196F3;
                    background-color: #f0f8ff;
                }

                .import-method.selected {
                    border-color: #2196F3;
                    background-color: #e3f2fd;
                }

                .import-config {
                    padding: 3vw;
                    border: 0.2vw solid #ddd;
                    border-radius: 1.5vw;
                    background-color: #f9f9f9;
                    margin-bottom: 4vw;
                }

                .import-config h4 {
                    margin: 0 0 3vw 0;
                    font-size: 4vw;
                    color: #333;
                }

                @media (max-width: 768px) {
                    .import-method-selection {
                        flex-direction: column;
                        gap: 2vw;
                    }
                }
            </style>
        `;

        // 添加样式和HTML到页面
        document.head.insertAdjacentHTML('beforeend', styleHTML);
        document.body.insertAdjacentHTML('beforeend', modalHTML);

        // 绑定事件
        this.bindImportEvents();

        // 显示模态窗口
        const modal = document.getElementById('importModal');
        modal.style.display = 'block';
        modal.offsetHeight; // 强制重排
        modal.classList.add('show');
    }

    // 绑定导入事件
    bindImportEvents() {
        const modal = document.getElementById('importModal');
        const closeBtn = document.querySelector('.import-close');
        const cancelBtn = document.getElementById('importCancel');
        const confirmBtn = document.getElementById('importConfirm');
        const importMethods = modal.querySelectorAll('.import-method');
        const localImportConfig = document.getElementById('localImportConfig');
        const serverImportConfig = document.getElementById('serverImportConfig');
        const testImportConnectionBtn = document.getElementById('testImportConnection');
        
        // 本地导入相关元素
        const fileNameInput = document.getElementById('importFileName');
        const browseFilesBtn = document.getElementById('browseFilesBtn');
        const availableFiles = document.getElementById('availableFiles');
        const filesList = document.getElementById('filesList');

        let selectedMethod = '';

        // 从localStorage读取服务器配置
        const savedServerConfig = localStorage.getItem('busRecords_serverConfig');
        if (savedServerConfig) {
            try {
                const config = JSON.parse(savedServerConfig);
                document.getElementById('importServerIp').value = config.ip || '';
                document.getElementById('importServerPort').value = config.port || '8080';
                document.getElementById('importEndpoint').value = config.importEndpoint || '/api/import';
            } catch (e) {
                console.warn('读取服务器配置失败:', e);
            }
        }

        // 导入方式选择
        importMethods.forEach(method => {
            method.addEventListener('click', () => {
                importMethods.forEach(m => m.classList.remove('selected'));
                method.classList.add('selected');
                selectedMethod = method.dataset.method;
                
                if (selectedMethod === 'local') {
                    localImportConfig.style.display = 'block';
                    serverImportConfig.style.display = 'none';
                } else if (selectedMethod === 'server') {
                    localImportConfig.style.display = 'none';
                    serverImportConfig.style.display = 'block';
                }
                
                this.validateImportOptions();
            });
        });

        // 测试导入服务器连接
        if (testImportConnectionBtn) {
            testImportConnectionBtn.addEventListener('click', () => {
                this.testImportServerConnection();
            });
        }

        // 输入验证
        ['importServerIp', 'importServerPort', 'importEndpoint'].forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                element.addEventListener('input', () => {
                    this.validateImportOptions();
                });
            }
        });

        // 监听文件名输入
        if (fileNameInput) {
            fileNameInput.addEventListener('input', () => {
                this.validateImportOptions();
            });
        }

        // 浏览文件按钮
        if (browseFilesBtn) {
            browseFilesBtn.addEventListener('click', () => {
                this.browseDownloadFiles(filesList, fileNameInput, availableFiles);
            });
        }

        // 关闭按钮
        closeBtn.addEventListener('click', () => this.closeImportDialog());
        cancelBtn.addEventListener('click', () => this.closeImportDialog());

        // 点击背景关闭
        modal.addEventListener('click', (e) => {
            if (e.target === modal) this.closeImportDialog();
        });

        // 确认导入按钮
        confirmBtn.addEventListener('click', () => {
            
            if (selectedMethod === 'local') {
                const fileName = fileNameInput.value.trim();
                if (fileName) {
                    this.closeImportDialog();
                    this.readFileWithPlusIO(fileName, 'merge');
                }
            } else if (selectedMethod === 'server') {
                const serverConfig = {
                    ip: document.getElementById('importServerIp').value.trim(),
                    port: document.getElementById('importServerPort').value.trim(),
                    importEndpoint: document.getElementById('importEndpoint').value.trim()
                };
                
                // 保存服务器配置
                const savedConfig = localStorage.getItem('busRecords_serverConfig');
                let config = {};
                if (savedConfig) {
                    try {
                        config = JSON.parse(savedConfig);
                    } catch (e) {
                        console.warn('解析服务器配置失败:', e);
                    }
                }
                
                // 合并配置
                config.ip = serverConfig.ip;
                config.port = serverConfig.port;
                config.importEndpoint = serverConfig.importEndpoint;
                localStorage.setItem('busRecords_serverConfig', JSON.stringify(config));
                
                this.closeImportDialog();
                this.importFromServer(serverConfig);
            }
        });

        // 验证函数
        this.validateImportOptions = () => {
            let isValid = false;
            
            if (selectedMethod === 'local') {
                const fileName = fileNameInput ? fileNameInput.value.trim() : '';
                isValid = fileName.length > 0;
            } else if (selectedMethod === 'server') {
                const ip = document.getElementById('importServerIp').value.trim();
                const port = document.getElementById('importServerPort').value.trim();
                const endpoint = document.getElementById('importEndpoint').value.trim();
                
                isValid = ip && port && endpoint && 
                         this.isValidServerAddress(ip) &&
                         parseInt(port) > 0 && parseInt(port) <= 65535;
            }
            
            confirmBtn.disabled = !isValid;
        };
    }

    // 测试导入服务器连接
    testImportServerConnection() {
        const ip = document.getElementById('importServerIp').value.trim();
        const port = document.getElementById('importServerPort').value.trim();
        const connectionStatus = document.getElementById('importConnectionStatus');
        const testBtn = document.getElementById('testImportConnection');
        
        if (!ip || !port) {
            connectionStatus.textContent = '请输入服务器地址和端口';
            connectionStatus.className = 'connection-status error';
            return;
        }
        
        // 显示测试状态
        connectionStatus.textContent = '测试连接中...';
        connectionStatus.className = 'connection-status testing';
        testBtn.disabled = true;
        
        const testUrl = `http://${ip}:${port}/ping`;
        const timeout = 5000; // 5秒超时
        
        // 创建超时Promise
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('连接超时')), timeout);
        });
        
        // 测试连接
        Promise.race([
            fetch(testUrl, {
                method: 'GET',
                mode: 'cors',
                headers: {
                    'Content-Type': 'application/json'
                }
            }),
            timeoutPromise
        ])
        .then(response => {
            if (response.ok) {
                connectionStatus.textContent = '连接成功！';
                connectionStatus.className = 'connection-status success';
            } else {
                connectionStatus.textContent = `连接失败 (${response.status})`;
                connectionStatus.className = 'connection-status error';
            }
        })
        .catch(error => {
            console.warn('服务器连接测试失败:', error);
            connectionStatus.textContent = '连接失败，请检查服务器配置';
            connectionStatus.className = 'connection-status error';
        })
        .finally(() => {
            testBtn.disabled = false;
        });

        // ESC键关闭
        const handleKeydown = (e) => {
            if (e.key === 'Escape') {
                this.closeImportDialog();
                document.removeEventListener('keydown', handleKeydown);
            }
        };
        document.addEventListener('keydown', handleKeydown);

    }

    // 浏览下载目录中的文件
    browseDownloadFiles(filesList, fileNameInput, availableFiles) {
        // 检查是否支持 plus.io
        if (typeof plus === 'undefined' || !plus.io) {
            this.showCustomAlert('功能不可用', '当前环境不支持文件浏览功能，请手动输入文件名');
            return;
        }

        // 清空文件列表
        filesList.innerHTML = '<div style="text-align: center; color: #666;">正在扫描文件...</div>';
        availableFiles.style.display = 'block';

        // 获取下载目录
        plus.io.resolveLocalFileSystemURL('file:///storage/emulated/0/Download/', (dirEntry) => {
            dirEntry.createReader().readEntries((entries) => {
                                // 过滤出.json文件
                                const jsonFiles = entries.filter(entry => 
                                    entry.isFile && entry.name.toLowerCase().endsWith('.json')
                                );

                                if (jsonFiles.length === 0) {
                                    filesList.innerHTML = '<div style="text-align: center; color: #999;">未找到 .json 文件</div>';
                                    return;
                                }

                                // 显示文件列表
                                filesList.innerHTML = '';
                                jsonFiles.forEach(fileEntry => {
                    const fileItem = document.createElement('div');
                    fileItem.className = 'file-item';
                    fileItem.textContent = fileEntry.name;
                    
                    fileItem.addEventListener('click', () => {
                        // 移除其他选中状态
                        document.querySelectorAll('.file-item').forEach(item => {
                            item.classList.remove('selected');
                        });
                        
                        // 选中当前文件
                        fileItem.classList.add('selected');
                        fileNameInput.value = fileEntry.name;
                        
                        // 启用确认按钮
                        document.getElementById('importConfirm').disabled = false;
                    });
                    
                    filesList.appendChild(fileItem);
                });
            }, (error) => {
                console.error('读取目录失败:', error);
                filesList.innerHTML = '<div style="text-align: center; color: #f44336;">读取目录失败</div>';
            });
        }, (error) => {
            console.error('访问下载目录失败:', error);
            filesList.innerHTML = '<div style="text-align: center; color: #f44336;">无法访问下载目录</div>';
        });
    }

    // 使用plus.io API读取文件
    readFileWithPlusIO(fileName, importMode = 'merge') {
        // 检查是否支持 plus.io
        if (typeof plus === 'undefined' || !plus.io) {
            this.showCustomAlert('功能不可用', '当前环境不支持plus.io API，请使用浏览器版本');
            return;
        }

        // 构建完整文件路径
        const filePath = `file:///storage/emulated/0/Download/${fileName}`;
        
        plus.io.resolveLocalFileSystemURL(filePath, (fileEntry) => {
            fileEntry.file((file) => {
                const reader = new plus.io.FileReader();
                
                reader.onloadend = (evt) => {
                    try {
                        const fileContent = evt.target.result;
                        this.performImport(fileContent, importMode);
                    } catch (error) {
                        console.error('解析文件内容失败:', error);
                        this.showCustomAlert('读取失败', '无法解析文件内容，请确认文件完整性');
                    }
                };
                
                reader.onerror = (error) => {
                    console.error('读取文件失败:', error);
                    this.showCustomAlert('读取失败', '文件读取时发生错误，请重新选择文件');
                };
                
                reader.readAsText(file);
            }, (error) => {
                console.error('获取文件对象失败:', error);
                this.showCustomAlert('读取失败', '无法获取文件对象，请检查文件是否存在');
            });
        }, (error) => {
            console.error('文件不存在或无法访问:', error);
            this.showCustomAlert('文件不存在', `无法找到文件：${fileName}\n请检查文件名是否正确或文件是否存在于下载目录中`);
        });
    }

    // 读取并导入文件（降级方案）
    readAndImportFile(file, importMode = 'merge') {
        const reader = new FileReader();
        
        reader.onload = (e) => {
            try {
                const fileContent = e.target.result;
                this.performImport(fileContent, importMode);
            } catch (error) {
                console.error('读取文件失败:', error);
                this.showCustomAlert('读取失败', '无法读取选择的文件，请确认文件完整性');
            }
        };

        reader.onerror = () => {
            this.showCustomAlert('读取失败', '文件读取时发生错误，请重新选择文件');
        };

        reader.readAsText(file, 'utf-8');
    }

    // 关闭导入对话框
    closeImportDialog() {
        const modal = document.getElementById('importModal');
        if (modal) {
            modal.classList.remove('show');
            setTimeout(() => {
                if (modal && modal.parentNode) {
                    document.body.removeChild(modal);
                }
                // 移除样式
                const styleElement = document.getElementById('importModalStyle');
                if (styleElement && styleElement.parentNode) {
                    document.head.removeChild(styleElement);
                }
            }, 300);
        }
    }

    // 执行导入
    async performImport(fileContent, importMode = 'merge') {
        try {
            // 尝试解析JSON数据（本地导入）或解密数据（服务器导入）
            let importData;
            try {
                // 首先尝试直接解析JSON（本地导入的新格式）
                if (fileContent.trim().startsWith('{')) {
                    importData = JSON.parse(fileContent);
                } else {
                    // 如果不是JSON格式，尝试解密解压缩（旧格式或服务器导入）
                    importData = this.decryptAndDecompress(fileContent);
                }
            } catch (error) {
                await this.showCustomAlert('数据格式错误', '无法解析导入数据，请确认文件格式是否正确（支持JSON格式）');
                return;
            }

            // 验证数据结构
            if (!importData.records || !Array.isArray(importData.records)) {
                await this.showCustomAlert('数据格式错误', '文件中没有找到有效的记录数据');
                return;
            }

            const importRecords = importData.records;
            
            if (importRecords.length === 0) {
                await this.showCustomAlert('导入提示', '文件中没有记录数据');
                return;
            }

            // 合并导入处理数据
            let addedCount = 0;
            let skippedCount = 0;
            let errorCount = 0;
            const newRecords = [];  // 收集新增记录

            // 构建已有记录的 Set，O(1) 去重
            const existSet = new Set(
                busRecordsManager.records.map(r =>
                    `${r.busId}||${r.lineName}||${r.date}`
                )
            );

            // 导入记录（仅支持合并模式）
            for (const record of importRecords) {
                try {
                    // 验证记录格式
                    if (!record.busId || !record.lineName || !record.date) {
                        errorCount++;
                        continue;
                    }

                    // 检查是否已存在（Set.has 为 O(1)）
                    const key = `${record.busId}||${record.lineName}||${record.date}`;
                    if (existSet.has(key)) {
                        skippedCount++;
                        continue;
                    }
                    existSet.add(key);  // 同时防止文件内部重复

                    // 收集新记录
                    const newRecord = {
                        id: Date.now() + Math.floor(Math.random() * 10000),
                        busId: record.busId,
                        lineName: record.lineName,
                        date: record.date,
                        recordTime: record.recordTime || '导入数据',
                        timestamp: record.timestamp || new Date().toISOString(),
                        isManual: record.isManual || false
                    };
                    busRecordsManager.records.push(newRecord);
                    newRecords.push(newRecord);
                    addedCount++;
                } catch (error) {
                    console.error('导入记录失败:', record, error);
                    errorCount++;
                }
            }

            // 只写入新增记录，不全量重写已有数据
            busRecordsManager.saveRecords(newRecords);

            // 关闭导入对话框
            this.closeImportDialog();

            // 刷新界面
            this.updateStatistics();
            this.loadRecords();

            // 显示导入结果
            let message = `数据导入完成！\n成功导入: ${addedCount} 条记录`;
            if (skippedCount > 0) {
                message += `\n跳过重复: ${skippedCount} 条记录`;
            }
            if (errorCount > 0) {
                message += `\n导入失败: ${errorCount} 条记录`;
            }

            await this.showCustomAlert('导入完成', message);

        } catch (error) {
            console.error('导入数据失败:', error);
            await this.showCustomAlert('导入失败', '导入数据时发生错误，请检查文件格式');
        }
    }

    // 处理导入数据
    async processImportData(importData, importMode = 'merge') {
        try {
            // 验证数据结构
            if (!importData.records || !Array.isArray(importData.records)) {
                throw new Error('文件中没有找到有效的记录数据');
            }

            const importRecords = importData.records;
            
            if (importRecords.length === 0) {
                throw new Error('文件中没有记录数据');
            }

            // 合并导入处理数据
            let addedCount = 0;
            let skippedCount = 0;
            let errorCount = 0;
            const newRecords = [];  // 收集新增记录，只写入这些

            // 构建已有记录的 Set，O(1) 去重，避免循环内 O(n) .some() 遍历
            const existSet = new Set(
                busRecordsManager.records.map(r =>
                    `${r.busId}||${r.lineName}||${r.date}`
                )
            );

            // 导入记录（仅支持合并模式）
            for (const record of importRecords) {
                try {
                    // 验证记录格式
                    if (!record.busId || !record.lineName || !record.date) {
                        errorCount++;
                        continue;
                    }

                    // 检查是否已存在（Set.has 为 O(1)）
                    const key = `${record.busId}||${record.lineName}||${record.date}`;
                    if (existSet.has(key)) {
                        skippedCount++;
                        continue;
                    }
                    existSet.add(key);  // 同时防止文件内部重复

                    // 收集新记录（不立即写入内存数组，减少 GC 压力）
                    const newRecord = {
                        id: Date.now() + Math.floor(Math.random() * 10000),
                        busId: record.busId,
                        lineName: record.lineName,
                        date: record.date,
                        recordTime: record.recordTime || '导入数据',
                        timestamp: record.timestamp || new Date().toISOString(),
                        isManual: record.isManual || false
                    };
                    busRecordsManager.records.push(newRecord);
                    newRecords.push(newRecord);
                    addedCount++;
                } catch (error) {
                    console.error('导入记录失败:', record, error);
                    errorCount++;
                }
            }

            // 只写入新增记录，不全量重写已有数据
            await busRecordsManager.saveRecords(newRecords);

            // 刷新界面
            this.updateStatistics();
            this.loadRecords();

            return {
                success: true,
                addedCount,
                skippedCount,
                errorCount,
                totalRecords: importRecords.length
            };

        } catch (error) {
            console.error('处理导入数据失败:', error);
            throw error;
        }
    }

    // 压缩加密数据
    compressAndEncrypt(data) {
        try {
            // 转换为JSON字符串
            const jsonString = JSON.stringify(data);
            
            // 简单的压缩：移除不必要的空格和换行
            const compressed = jsonString.replace(/\s+/g, ' ').trim();
            
            // Base64编码（作为"加密"）
            const encoded = btoa(unescape(encodeURIComponent(compressed)));
            
            // 添加标识前缀和校验
            const checksum = this.simpleChecksum(encoded);
            return `BRS1_${encoded}_${checksum}`;
            
        } catch (error) {
            throw new Error('数据压缩加密失败');
        }
    }

    // 解压解密数据
    decryptAndDecompress(encryptedData) {
        try {
            // 检查格式
            if (!encryptedData.startsWith('BRS1_')) {
                throw new Error('不支持的数据格式');
            }
            
            // 提取数据和校验码
            const parts = encryptedData.split('_');
            if (parts.length !== 3) {
                throw new Error('数据格式错误');
            }
            
            const encoded = parts[1];
            const checksum = parts[2];
            
            // 验证校验码
            if (this.simpleChecksum(encoded) !== checksum) {
                throw new Error('数据校验失败，可能已损坏');
            }
            
            // Base64解码
            const compressed = decodeURIComponent(escape(atob(encoded)));
            
            // 解析JSON
            const data = JSON.parse(compressed);
            
            return data;
            
        } catch (error) {
            throw new Error('数据解密解压失败: ' + error.message);
        }
    }

    // 简单校验和
    simpleChecksum(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // 转换为32位整数
        }
        return Math.abs(hash).toString(36);
    }

    // 禁用主程序的自动刷新功能
    disableAutoRefresh() {
        try {
            // 保存原始的自动刷新状态和函数
            this.originalAutoRefreshState = {};
            
            // 禁用常见的自动刷新定时器
            if (window.autoRefreshTimer) {
                console.log('清除自动刷新定时器: autoRefreshTimer');
                clearInterval(window.autoRefreshTimer);
                this.originalAutoRefreshState.autoRefreshTimer = window.autoRefreshTimer;
                window.autoRefreshTimer = null;
            }
            
            if (window.refreshTimer) {
                console.log('清除自动刷新定时器: refreshTimer');
                clearInterval(window.refreshTimer);
                this.originalAutoRefreshState.refreshTimer = window.refreshTimer;
                window.refreshTimer = null;
            }
            
            if (window.intervalId) {
                console.log('清除自动刷新定时器: intervalId');
                clearInterval(window.intervalId);
                this.originalAutoRefreshState.intervalId = window.intervalId;
                window.intervalId = null;
            }
            
            // 禁用可能的自动刷新函数
            const autoRefreshFunctions = [
                'autoRefresh',
                'startAutoRefresh', 
                'enableAutoRefresh',
                'autoUpdate',
                'periodicRefresh',
                'scheduleRefresh'
            ];
            
            autoRefreshFunctions.forEach(funcName => {
                if (typeof window[funcName] === 'function') {
                    console.log(`临时禁用自动刷新函数: ${funcName}`);
                    this.originalAutoRefreshState[funcName] = window[funcName];
                    window[funcName] = () => {
                        console.log(`批量查询期间跳过自动刷新调用: ${funcName}`);
                    };
                }
            });
            
            // 设置标志位，表明当前正在批量查询
            window._batchQueryInProgress = true;
            
            console.log('已禁用主程序自动刷新功能');
            
        } catch (error) {
            console.error('禁用自动刷新功能失败:', error);
        }
    }

    // 恢复主程序的自动刷新功能
    enableAutoRefresh() {
        try {
            if (!this.originalAutoRefreshState) {
                console.log('没有找到原始自动刷新状态，跳过恢复');
                return;
            }
            
            // 恢复自动刷新定时器
            if (this.originalAutoRefreshState.autoRefreshTimer) {
                console.log('恢复自动刷新定时器: autoRefreshTimer');
                // 注意：这里不能直接恢复定时器ID，需要重新启动
                if (typeof window.startAutoRefresh === 'function') {
                    window.startAutoRefresh();
                } else if (typeof window.enableAutoRefresh === 'function') {
                    window.enableAutoRefresh();
                }
            }
            
            if (this.originalAutoRefreshState.refreshTimer) {
                console.log('恢复自动刷新定时器: refreshTimer');
                // 同样需要重新启动而不是恢复ID
                if (typeof window.startRefreshTimer === 'function') {
                    window.startRefreshTimer();
                }
            }
            
            if (this.originalAutoRefreshState.intervalId) {
                console.log('恢复自动刷新定时器: intervalId');
                // 重新启动定时器
                if (typeof window.startInterval === 'function') {
                    window.startInterval();
                }
            }
            
            // 恢复自动刷新函数
            Object.keys(this.originalAutoRefreshState).forEach(key => {
                if (typeof this.originalAutoRefreshState[key] === 'function') {
                    console.log(`恢复自动刷新函数: ${key}`);
                    window[key] = this.originalAutoRefreshState[key];
                }
            });
            
            // 清除标志位
            window._batchQueryInProgress = false;
            
            // 清理保存的状态
            this.originalAutoRefreshState = null;
            
            console.log('已恢复主程序自动刷新功能');
            
            // 尝试立即启动自动刷新（如果有相关函数）
            const startFunctions = [
                'startAutoRefresh',
                'enableAutoRefresh', 
                'resumeAutoRefresh',
                'initAutoRefresh'
            ];
            
            for (const funcName of startFunctions) {
                if (typeof window[funcName] === 'function') {
                    console.log(`尝试启动自动刷新: ${funcName}`);
                    try {
                        window[funcName]();
                        break; // 成功启动一个就够了
                    } catch (error) {
                        console.warn(`启动${funcName}失败:`, error);
                    }
                }
            }
            
        } catch (error) {
            console.error('恢复自动刷新功能失败:', error);
        }
    }

    // 显示导出数据对话框（选择导出方式）
    showExportDialog() {
        // 移除已存在的导出窗口
        const existingModal = document.getElementById('exportModal');
        if (existingModal) {
            document.body.removeChild(existingModal);
        }

        const modalHTML = `
            <div id="exportModal" class="export-modal" style="display: none;">
                <div class="export-content">
                    <div class="export-header">
                        <h2>导出车牌记录数据</h2>
                        <span class="export-close">&times;</span>
                    </div>
                    <div class="export-body">
                        <div class="export-info">
                            <p>选择导出方式：导出到本地文件或远程服务器。</p>
                            <p style="color: #2196F3;">数据将以JSON格式导出，确保最佳兼容性。</p>
                        </div>
                        
                        <div class="export-method-selection">
                            <div class="export-method" data-method="local">
                                <div class="method-icon">💾</div>
                                <div class="method-info">
                                    <h3>本地导出</h3>
                                    <p>下载到设备本地</p>
                                    <small>适用于本地备份</small>
                                </div>
                            </div>
                            <div class="export-method" data-method="server">
                                <div class="method-icon">🌐</div>
                                <div class="method-info">
                                    <h3>服务器导出</h3>
                                    <p>上传到远程服务器</p>
                                    <small>适用于数据同步</small>
                                </div>
                            </div>
                        </div>
                        
                        <div class="export-actions">
                            <button id="exportCancel" class="cancel-btn">取消</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const styleHTML = `
            <style id="exportModalStyle">
                .export-modal {
                    display: none;
                    position: fixed;
                    z-index: 1003;
                    left: 0;
                    top: 0;
                    width: 100%;
                    height: 100%;
                    background-color: rgba(0,0,0,0.6);
                    opacity: 0;
                    transition: opacity 0.3s ease-out;
                }

                .export-modal.show {
                    opacity: 1;
                }

                .export-content {
                    background-color: #fefefe;
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%) scale(0.7);
                    border: 0.2vw solid #888;
                    width: 90%;
                    max-width: 90vw;
                    max-height: calc(var(--app-vh, 100vh) * 0.85);
                    border-radius: 2vw;
                    overflow-y: auto;
                    overflow-x: hidden;
                    opacity: 0;
                    transition: all 0.3s ease-out;
                    display: flex;
                    flex-direction: column;
                }

                .export-modal.show .export-content {
                    transform: translate(-50%, -50%) scale(1);
                    opacity: 1;
                }

                .export-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 4vw;
                    background-color: #f5f5f5;
                    border-bottom: 0.2vw solid #ddd;
                }

                .export-header h2 {
                    margin: 0;
                    font-size: 4.5vw;
                    font-family: 'FZH', sans-serif;
                    color: #333;
                }

                .export-close {
                    color: #aaa;
                    font-size: 6vw;
                    font-weight: bold;
                    cursor: pointer;
                }

                .export-close:hover {
                    color: black;
                }

                .export-body {
                    padding: 4vw;
                }

                .export-info {
                    margin-bottom: 4vw;
                }

                .export-info p {
                    margin: 1.5vw 0;
                    font-size: 3.5vw;
                    font-family: 'FZH', sans-serif;
                    line-height: 1.5;
                }

                .export-method-selection {
                    display: flex;
                    gap: 3vw;
                    margin-bottom: 4vw;
                }

                .export-method {
                    flex: 1;
                    padding: 3vw;
                    border: 0.3vw solid #ddd;
                    border-radius: 1.5vw;
                    cursor: pointer;
                    transition: all 0.3s ease;
                    text-align: center;
                }

                .export-method:hover {
                    border-color: #2196F3;
                    background-color: #f0f8ff;
                }

                .method-icon {
                    font-size: 8vw;
                    margin-bottom: 2vw;
                }

                .method-info h3 {
                    margin: 0 0 1vw 0;
                    font-size: 4vw;
                    font-family: 'FZH', sans-serif;
                    color: #333;
                }

                .method-info p {
                    margin: 0.5vw 0;
                    font-size: 3.2vw;
                    color: #666;
                }

                .method-info small {
                    font-size: 2.8vw;
                    color: #888;
                }

                .export-actions {
                    display: flex;
                    gap: 2vw;
                    justify-content: flex-end;
                }

                .export-actions button {
                    padding: 2.2vw 4vw;
                    border: none;
                    border-radius: 1.2vw;
                    cursor: pointer;
                    font-size: 3.5vw;
                    line-height: 1.2;
                    font-family: 'FZH', sans-serif;
                    box-sizing: border-box;
                    transition: background-color 0.3s;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    overflow: hidden;
                }

                .cancel-btn {
                    background-color: #f44336;
                    color: white;
                }

                .cancel-btn:hover {
                    background-color: #da190b;
                }

                @media (max-width: 768px) {
                    .export-content {
                        margin: 2% auto;
                        width: 95%;
                        max-height: calc(var(--app-vh, 100vh) * 0.95);
                    }

                    .export-method-selection {
                        flex-direction: column;
                        gap: 2vw;
                    }
                    
                    .export-actions {
                        flex-direction: column;
                        gap: 3vw;
                    }

                    .export-actions button {
                        width: 100%;
                        padding: 4vw;
                        font-size: 4vw;
                    }
                }
            </style>
        `;

        // 删除现有样式（如果存在）
        const existingStyle = document.getElementById('exportModalStyle');
        if (existingStyle) {
            document.head.removeChild(existingStyle);
        }

        document.head.insertAdjacentHTML('beforeend', styleHTML);
        document.body.insertAdjacentHTML('beforeend', modalHTML);

        // 绑定事件
        this.bindExportEvents();

        // 显示模态窗口
        const modal = document.getElementById('exportModal');
        modal.style.display = 'block';
        setTimeout(() => {
            modal.classList.add('show');
        }, 10);
    }

    // 绑定导出事件
    bindExportEvents() {
        const modal = document.getElementById('exportModal');
        const closeBtn = document.querySelector('.export-close');
        const cancelBtn = document.getElementById('exportCancel');
        const exportMethods = document.querySelectorAll('.export-method');

        // 关闭按钮
        closeBtn.addEventListener('click', () => this.closeExportDialog());

        // 取消按钮
        cancelBtn.addEventListener('click', () => this.closeExportDialog());

        // 点击背景关闭
        modal.addEventListener('click', (e) => {
            if (e.target === modal) this.closeExportDialog();
        });

        // 导出方式选择
        exportMethods.forEach(method => {
            method.addEventListener('click', () => {
                const methodType = method.getAttribute('data-method');
                this.closeExportDialog();
                
                if (methodType === 'local') {
                    this.exportToLocal();
                } else if (methodType === 'server') {
                    this.showServerExportDialog();
                }
            });
        });
    }

    // 关闭导出对话框
    closeExportDialog() {
        const modal = document.getElementById('exportModal');
        if (modal) {
            modal.classList.remove('show');
            setTimeout(() => {
                if (modal && modal.parentNode) {
                    document.body.removeChild(modal);
                }
                // 移除样式
                const styleElement = document.getElementById('exportModalStyle');
                if (styleElement && styleElement.parentNode) {
                    document.head.removeChild(styleElement);
                }
            }, 300);
        }
    }

    // 导出到本地
    exportToLocal() {
        try {
            const records = busRecordsManager.records;
            const statistics = busRecordsManager.getStatistics();
            
            // 创建导出数据对象（JSON格式）
            const exportData = {
                version: "1.0",
                exported_at: new Date().toISOString(),
                device_info: {
                    platform: navigator.platform || 'Unknown',
                    userAgent: navigator.userAgent,
                    appVersion: "1.0.0"
                },
                statistics: statistics,
                records: records,
                record_count: records.length
            };

            // 创建下载链接
            const jsonString = JSON.stringify(exportData, null, 2);
            const blob = new Blob([jsonString], { type: 'application/json' });
            const url = URL.createObjectURL(blob);

            // 生成文件名
            const now = new Date();
            const dateStr = now.toISOString().split('T')[0].replace(/-/g, '');
            const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '');
            const fileName = `车牌记录_${records.length}条_${dateStr}_${timeStr}.json`;

            // 创建下载链接
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            
            // 释放URL对象
            URL.revokeObjectURL(url);

            // 显示成功消息
            this.showCustomAlert('导出成功', `成功导出 ${records.length} 条记录到文件：\n${fileName}`);
            
        } catch (error) {
            console.error('本地导出失败:', error);
            this.showCustomAlert('导出失败', '导出数据时发生错误，请稍后重试。');
        }
    }
}

// 创建全局实例
const busRecordsManager = new BusRecordsManager();
const busRecordsModal = new BusRecordsModal();

// 导出到全局作用域
window.busRecordsManager = busRecordsManager;
window.busRecordsModal = busRecordsModal; 

// 输出可用的调试方法
console.log('🔧 可用的调试方法:');
console.log('- busRecordsManager.showServerExportDialog(): 显示服务器导出对话框');
console.log('- busRecordsManager.exportToServer(config): 服务器导出数据');
console.log('- busRecordsManager.showImportDialog(): 显示导入对话框（本地/服务器）');
console.log('- busRecordsManager.importFromServer(config): 从服务器导入数据');
console.log('- busRecordsManager.testServerConnection(): 测试服务器连接'); 