import express from 'express';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createClient } from '@supabase/supabase-js';

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Global Middlewares
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: true, limit: '25mb' }));
  app.use(cookieParser());

  // Health check API
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'StressCheck Server',
      timestamp: new Date().toISOString(),
    });
  });

  // Supabase Public Config Endpoint (Provides runtime environment variables to the frontend)
  app.get('/api/supabase-config', (req, res) => {
    const url =
      process.env.VITE_SUPABASE_URL ||
      'https://mnsjgwdxaiutxupbxrrb.supabase.co';
    const publishableKey =
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
      '';

    const isConfigured = Boolean(
      url &&
      publishableKey &&
      url.startsWith('http') &&
      !url.includes('placeholder')
    );

    res.json({
      isConfigured,
      url,
      publishableKey,
    });
  });

  // Server-side Secure Clear User Operational Data Endpoint
  app.post('/api/clear-user-data', async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: Missing or invalid authorization token.' });
      }

      const token = authHeader.split(' ')[1];
      const supabaseUrl =
        process.env.VITE_SUPABASE_URL ||
        'https://mnsjgwdxaiutxupbxrrb.supabase.co';
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const anonKey =
        process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
        process.env.VITE_SUPABASE_ANON_KEY ||
        '';

      // 1. Authenticate caller using their JWT to derive user.id
      const authVerificationClient = createClient(supabaseUrl, anonKey || serviceRoleKey || '', {
        auth: { persistSession: false },
      });

      const { data: authData, error: authErr } = await authVerificationClient.auth.getUser(token);
      if (authErr || !authData?.user) {
        console.warn('Clear user data authorization error:', authErr?.message);
        return res.status(401).json({ error: 'Unauthorized: Invalid or expired session.' });
      }

      const callerUserId = authData.user.id;

      // 2. Client for database operations
      const opClient = createClient(supabaseUrl, serviceRoleKey || anonKey || '', {
        auth: { persistSession: false },
        global: {
          headers: serviceRoleKey ? {} : { Authorization: `Bearer ${token}` },
        },
      });

      // 3. Obtain caller's role
      const { data: profile } = await opClient
        .from('profiles')
        .select('role')
        .eq('user_id', callerUserId)
        .maybeSingle();

      const userRole = profile?.role?.toUpperCase() || (authData.user.user_metadata?.role?.toUpperCase() || 'FARMER');

      // 4. Delete user-owned Storage objects
      try {
        const { data: assessFiles } = await opClient.storage.from('assessment-media').list(callerUserId);
        if (assessFiles && assessFiles.length > 0) {
          const filePaths = assessFiles
            .filter((f) => f.name && !f.name.startsWith('.'))
            .map((f) => `${callerUserId}/${f.name}`);
          if (filePaths.length > 0) {
            await opClient.storage.from('assessment-media').remove(filePaths);
          }
        }

        const consultSubdirs = ['', 'photos', 'videos', 'prescriptions', 'documents'];
        for (const sub of consultSubdirs) {
          const prefix = sub ? `${callerUserId}/${sub}` : callerUserId;
          const { data: cFiles } = await opClient.storage.from('consultation-media').list(prefix);
          if (cFiles && cFiles.length > 0) {
            const paths = cFiles
              .filter((f) => f.name && !f.name.startsWith('.'))
              .map((f) => `${prefix}/${f.name}`);
            if (paths.length > 0) {
              await opClient.storage.from('consultation-media').remove(paths);
            }
          }
        }
      } catch (storageErr) {
        console.warn('Storage cleanup notice during data clearing:', storageErr);
      }

      // 5. Delete records in dependency order
      if (userRole === 'FARMER') {
        // Collect user's animals
        const { data: userAnimals } = await opClient
          .from('animals')
          .select('id')
          .or(`owner_user_id.eq.${callerUserId},user_id.eq.${callerUserId}`);

        const animalIds = (userAnimals || []).map((a: any) => a.id);

        // Collect user's assessments
        let assessQuery = opClient
          .from('assessments')
          .select('id')
          .or(`owner_user_id.eq.${callerUserId},user_id.eq.${callerUserId}`);

        const { data: userAssessments } = await assessQuery;
        let assessmentIds = (userAssessments || []).map((a: any) => a.id);

        if (animalIds.length > 0) {
          const { data: animalAssessments } = await opClient
            .from('assessments')
            .select('id')
            .in('animal_id', animalIds);
          if (animalAssessments) {
            for (const a of animalAssessments) {
              if (!assessmentIds.includes(a.id)) {
                assessmentIds.push(a.id);
              }
            }
          }
        }

        // Collect consultations initiated by this farmer
        const { data: farmerConsults } = await opClient
          .from('consultations')
          .select('id')
          .eq('farmer_id', callerUserId);

        const consultationIds = (farmerConsults || []).map((c: any) => c.id);

        // A. Remove consultation dependencies
        if (consultationIds.length > 0) {
          await opClient.from('consultation_files').delete().in('consultation_id', consultationIds);
          await opClient.from('consultation_messages').delete().in('consultation_id', consultationIds);
          await opClient.from('vet_prescriptions').delete().in('consultation_id', consultationIds);
          await opClient.from('vet_assessments').delete().in('consultation_id', consultationIds);
          await opClient.from('notifications').delete().in('consultation_id', consultationIds);
          await opClient.from('consultations').delete().in('id', consultationIds);
        }

        // Also delete any consultation directly tied to farmer_id
        await opClient.from('consultations').delete().eq('farmer_id', callerUserId);

        // B. Remove assessment dependencies
        if (assessmentIds.length > 0) {
          await opClient.from('recommendations').delete().in('assessment_id', assessmentIds);
          await opClient.from('assessment_media').delete().in('assessment_id', assessmentIds);
          await opClient.from('environmental_readings').delete().in('assessment_id', assessmentIds);
          await opClient.from('physiological_readings').delete().in('assessment_id', assessmentIds);
          await opClient.from('assessments').delete().in('id', assessmentIds);
        }

        // Also delete any assessment directly by owner_user_id
        await opClient.from('assessments').delete().eq('owner_user_id', callerUserId);

        // C. Remove animals owned by the farmer
        if (animalIds.length > 0) {
          await opClient.from('animals').delete().in('id', animalIds);
        }
        await opClient.from('animals').delete().eq('owner_user_id', callerUserId);

        // D. Remove notifications belonging to this farmer
        await opClient.from('notifications').delete().eq('user_id', callerUserId);

        // Re-verify deletion
        const { count: remainingAnimals } = await opClient
          .from('animals')
          .select('*', { count: 'exact', head: true })
          .eq('owner_user_id', callerUserId);

        const { count: remainingAssessments } = await opClient
          .from('assessments')
          .select('*', { count: 'exact', head: true })
          .eq('owner_user_id', callerUserId);

        const { count: remainingConsultations } = await opClient
          .from('consultations')
          .select('*', { count: 'exact', head: true })
          .eq('farmer_id', callerUserId);

        if ((remainingAnimals || 0) > 0 || (remainingAssessments || 0) > 0 || (remainingConsultations || 0) > 0) {
          console.warn('Partial deletion warning:', { remainingAnimals, remainingAssessments, remainingConsultations });
          return res.status(500).json({
            error: 'Unable to clear your LivHi data. Please try again.',
          });
        }
      } else if (userRole === 'VETERINARIAN') {
        // Clear vet notifications; preserve shared farmer consultations and vet profile/credentials
        await opClient.from('notifications').delete().eq('user_id', callerUserId);
      } else {
        await opClient.from('notifications').delete().eq('user_id', callerUserId);
      }

      return res.json({
        success: true,
        message: 'Your LivHi data has been cleared.',
      });
    } catch (err: any) {
      console.error('Clear user data server error:', err);
      return res.status(500).json({
        error: 'Unable to clear your LivHi data. Please try again.',
      });
    }
  });

  // Server-side Secure Account Deletion Endpoint
  app.post('/api/delete-account', async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: Missing or invalid authorization token.' });
      }

      const token = authHeader.split(' ')[1];
      const supabaseUrl =
        process.env.VITE_SUPABASE_URL ||
        'https://mnsjgwdxaiutxupbxrrb.supabase.co';
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const anonKey =
        process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
        process.env.VITE_SUPABASE_ANON_KEY ||
        '';

      // 1. Authenticate caller using their JWT
      const authVerificationClient = createClient(supabaseUrl, anonKey || serviceRoleKey || '', {
        auth: { persistSession: false },
      });

      const { data: authData, error: authErr } = await authVerificationClient.auth.getUser(token);
      if (authErr || !authData?.user) {
        console.warn('Delete account authorization error:', authErr?.message);
        return res.status(401).json({ error: 'Unauthorized: Invalid or expired session.' });
      }

      const callerUserId = authData.user.id;

      // 2. Client for database operations (use service role if available for full admin deletion, else user-scoped client)
      const opClient = createClient(supabaseUrl, serviceRoleKey || anonKey || '', {
        auth: { persistSession: false },
        global: {
          headers: serviceRoleKey ? {} : { Authorization: `Bearer ${token}` },
        },
      });

      // 3. Obtain caller's role and profile
      const { data: profile } = await opClient
        .from('profiles')
        .select('role')
        .eq('user_id', callerUserId)
        .maybeSingle();

      const userRole = profile?.role?.toUpperCase() || (authData.user.user_metadata?.role?.toUpperCase() || 'FARMER');

      // 4. Delete user-owned Storage objects through the Storage API
      try {
        // Assessment media bucket
        const { data: assessFiles } = await opClient.storage.from('assessment-media').list(callerUserId);
        if (assessFiles && assessFiles.length > 0) {
          const filePaths = assessFiles
            .filter((f) => f.name && !f.name.startsWith('.'))
            .map((f) => `${callerUserId}/${f.name}`);
          if (filePaths.length > 0) {
            await opClient.storage.from('assessment-media').remove(filePaths);
          }
        }

        // Consultation media bucket subdirectories
        const consultSubdirs = ['', 'photos', 'videos', 'prescriptions', 'documents'];
        for (const sub of consultSubdirs) {
          const prefix = sub ? `${callerUserId}/${sub}` : callerUserId;
          const { data: cFiles } = await opClient.storage.from('consultation-media').list(prefix);
          if (cFiles && cFiles.length > 0) {
            const paths = cFiles
              .filter((f) => f.name && !f.name.startsWith('.'))
              .map((f) => `${prefix}/${f.name}`);
            if (paths.length > 0) {
              await opClient.storage.from('consultation-media').remove(paths);
            }
          }
        }
      } catch (storageErr) {
        console.warn('Storage cleanup notice during account deletion:', storageErr);
      }

      // 5. Delete user-owned application records in safe dependency order
      if (userRole === 'FARMER') {
        // User's animals
        const { data: userAnimals } = await opClient
          .from('animals')
          .select('id')
          .or(`owner_user_id.eq.${callerUserId},user_id.eq.${callerUserId}`);

        const animalIds = (userAnimals || []).map((a: any) => a.id);

        // User's assessments
        const { data: userAssessments } = await opClient
          .from('assessments')
          .select('id')
          .or(`owner_user_id.eq.${callerUserId},user_id.eq.${callerUserId}`);

        let assessmentIds = (userAssessments || []).map((a: any) => a.id);
        if (animalIds.length > 0) {
          const { data: animalAssessments } = await opClient
            .from('assessments')
            .select('id')
            .in('animal_id', animalIds);
          if (animalAssessments) {
            for (const a of animalAssessments) {
              if (!assessmentIds.includes(a.id)) {
                assessmentIds.push(a.id);
              }
            }
          }
        }

        // Consultations initiated by the farmer
        const { data: farmerConsults } = await opClient
          .from('consultations')
          .select('id')
          .eq('farmer_id', callerUserId);

        const consultationIds = (farmerConsults || []).map((c: any) => c.id);

        if (consultationIds.length > 0) {
          await opClient.from('consultation_files').delete().in('consultation_id', consultationIds);
          await opClient.from('consultation_messages').delete().in('consultation_id', consultationIds);
          await opClient.from('vet_prescriptions').delete().in('consultation_id', consultationIds);
          await opClient.from('vet_assessments').delete().in('consultation_id', consultationIds);
          await opClient.from('notifications').delete().in('consultation_id', consultationIds);
          await opClient.from('consultations').delete().in('id', consultationIds);
        }
        await opClient.from('consultations').delete().eq('farmer_id', callerUserId);

        // Farmer's assessments and readings
        if (assessmentIds.length > 0) {
          await opClient.from('assessment_media').delete().in('assessment_id', assessmentIds);
          await opClient.from('environmental_readings').delete().in('assessment_id', assessmentIds);
          await opClient.from('physiological_readings').delete().in('assessment_id', assessmentIds);
          await opClient.from('assessments').delete().in('id', assessmentIds);
        }
        await opClient.from('assessments').delete().eq('owner_user_id', callerUserId);

        // Farmer's animals
        if (animalIds.length > 0) {
          await opClient.from('animals').delete().in('id', animalIds);
        }
        await opClient.from('animals').delete().eq('owner_user_id', callerUserId);

        // Notifications
        await opClient.from('notifications').delete().eq('user_id', callerUserId);

        // Profiles
        await opClient.from('farmer_profiles').delete().eq('user_id', callerUserId);
        await opClient.from('profiles').delete().eq('user_id', callerUserId);
      } else if (userRole === 'VETERINARIAN') {
        // Preserve farmer's consultation records: detach veterinarian link safely
        await opClient
          .from('consultations')
          .update({ veterinarian_id: null })
          .eq('veterinarian_id', callerUserId);

        // Remove vet's direct notifications
        await opClient.from('notifications').delete().eq('user_id', callerUserId);

        // Remove vet profiles
        await opClient.from('veterinarian_profiles').delete().eq('user_id', callerUserId);
        await opClient.from('profiles').delete().eq('user_id', callerUserId);
      } else {
        // Admin or standard user
        await opClient.from('notifications').delete().eq('user_id', callerUserId);
        await opClient.from('profiles').delete().eq('user_id', callerUserId);
      }

      // 6. Delete the Supabase Auth user if service-role key is available
      if (serviceRoleKey) {
        const adminClient = createClient(supabaseUrl, serviceRoleKey, {
          auth: { persistSession: false },
        });
        const { error: adminDelErr } = await adminClient.auth.admin.deleteUser(callerUserId);
        if (adminDelErr) {
          console.warn('Admin user deletion notice:', adminDelErr.message);
        }
      }

      return res.json({
        success: true,
        message: 'Your LivHI account has been permanently deleted.',
      });
    } catch (err: any) {
      console.error('Delete account server error:', err);
      return res.status(500).json({
        error: 'Your account could not be deleted. Please try again.',
      });
    }
  });

  // Weather Proxy Endpoint (Avoids client-side browser CORS / network restrictions)
  app.get('/api/weather', async (req, res) => {
    const { latitude, longitude } = req.query;
    if (!latitude || !longitude) {
      return res.status(400).json({ error: 'latitude and longitude are required' });
    }

    const lat = parseFloat(latitude as string);
    const lon = parseFloat(longitude as string);

    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'invalid latitude or longitude' });
    }

    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,dew_point_2m,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,uv_index&daily=temperature_2m_max,temperature_2m_min,uv_index_max&timezone=auto`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'StressCheck/1.0' }
      });

      if (!response.ok) {
        return res.status(response.status).json({
          error: `Open-Meteo responded with status ${response.status}`
        });
      }

      const data = await response.json();
      return res.json(data);
    } catch (err: any) {
      console.error('Weather proxy error:', err);
      return res.status(502).json({
        error: err?.message || 'Failed to fetch weather data'
      });
    }
  });

  // Reverse Geocoding Proxy Endpoint
  app.get('/api/reverse-geocode', async (req, res) => {
    const { latitude, longitude } = req.query;
    if (!latitude || !longitude) {
      return res.status(400).json({ error: 'latitude and longitude are required' });
    }

    const lat = parseFloat(latitude as string);
    const lon = parseFloat(longitude as string);

    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'invalid latitude or longitude' });
    }

    try {
      const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
      const response = await fetch(url);
      if (!response.ok) {
        return res.status(response.status).json({ error: 'Failed to reverse geocode' });
      }
      const data = await response.json();
      return res.json(data);
    } catch (err: any) {
      return res.status(502).json({ error: err?.message || 'Failed to reverse geocode' });
    }
  });

  // Location Search Proxy Endpoint
  app.get('/api/search-locations', async (req, res) => {
    const { query } = req.query;
    if (!query || typeof query !== 'string' || query.trim().length < 2) {
      return res.json({ results: [] });
    }

    try {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query.trim())}&count=6&language=en&format=json`;
      const response = await fetch(url);
      if (!response.ok) {
        return res.status(response.status).json({ results: [] });
      }
      const data = await response.json();
      return res.json(data);
    } catch (err: any) {
      return res.status(502).json({ results: [] });
    }
  });

  // Serve Public Static Files (Logos, Assets, etc.)
  app.use('/assets', express.static(path.join(process.cwd(), 'public', 'assets')));
  app.use(express.static(path.join(process.cwd(), 'public')));

  // Vite Dev Server / Static Production Serve
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`LivHI server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
