import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProcessLifecycleService } from '../../../src/infrastructure/process-lifecycle-service.ts';
import { execFile } from 'node:child_process';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

describe('ProcessLifecycleService', () => {
  let service: ProcessLifecycleService;

  beforeEach(() => {
    service = new ProcessLifecycleService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('isProcessAlive', () => {
    it('should return true if signal 0 succeeds', async () => {
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as any);
      const alive = await service.isProcessAlive(process.pid);
      expect(alive).toBe(true);
      killSpy.mockRestore();
    });

    it('should return false if signal 0 throws', async () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('ESRCH');
      });
      const alive = await service.isProcessAlive(999999);
      expect(alive).toBe(false);
      killSpy.mockRestore();
    });
    
    it('should verify start time using getProcessStartTime', async () => {
        const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as any);
        const getStartSpy = vi.spyOn(service, 'getProcessStartTime').mockResolvedValue(1000);
        
        const alive = await service.isProcessAlive(123, 1000);
        expect(alive).toBe(true);
        expect(getStartSpy).toHaveBeenCalledWith(123);
        
        const dead = await service.isProcessAlive(123, 2000);
        expect(dead).toBe(false);
        
        killSpy.mockRestore();
        getStartSpy.mockRestore();
    });
  });

  describe('getProcessStartTime', () => {
    it('should fallback to ps on non-Linux', async () => {
      vi.stubGlobal('process', { ...process, platform: 'darwin' });

      vi.mocked(execFile).mockImplementation(((_cmd, _args, _opts, cb) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        (callback as any)(null, '500\n', '');
        return { unref: () => {} };
      }) as any);

      const startTime = await service.getProcessStartTime(123);
      
      expect(startTime).not.toBeNull();
      if (typeof startTime === 'number') {
        const now = Math.floor(Date.now() / 1000);
        const expected = now - 500;
        expect(startTime).toBeGreaterThanOrEqual(expected - 10);
        expect(startTime).toBeLessThanOrEqual(expected + 10);
      } else {
        throw new Error(`Expected number, got ${typeof startTime}`);
      }
    });

    it('should read start time on Windows using powershell', async () => {
      vi.stubGlobal('process', { ...process, platform: 'win32' });

      vi.mocked(execFile).mockImplementation(((_cmd, _args, _opts, cb) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        (callback as any)(null, '1600000000\n', '');
        return { unref: () => {} };
      }) as any);

      const startTime = await service.getProcessStartTime(123);
      expect(startTime).toBe(1600000000);
    });
  });

  describe('waitForProcessTermination', () => {
    it('should return true when process dies', async () => {
      const killSpy = vi.spyOn(process, 'kill');
      killSpy.mockReturnValueOnce(true as any).mockImplementationOnce(() => { throw new Error(); });

      const terminated = await service.waitForProcessTermination(123, 1000, 10);
      expect(terminated).toBe(true);
      
      killSpy.mockRestore();
    });
  });
});
