var connect        = require('connect');
var cookieParser   = require('cookie');
var crypto         = require('crypto');
var daemon         = require('daemon');
var fs             = require('fs');
var program        = require('commander');
var sanitizer      = require('validator').sanitize;
var socketio       = require('socket.io');
var tail           = require('./lib/tail');
var connectBuilder = require('./lib/connect_builder');
var serverBuilder = require('./lib/server_builder');

(function () {
    'use strict';

    program
        .version(require('./package.json').version)
        .usage('[options] [file ...]')
        .option('-h, --host <host>', 'listening host, default 0.0.0.0', String, '0.0.0.0')
        .option('-p, --port <port>', 'listening port, default 9001', Number, 9001)
        .option('-n, --number <number>', 'starting lines number, default 10', Number, 10)
        .option('-l, --lines <lines>', 'number on lines stored in browser, default 2000', Number, 2000)
        .option('-t, --theme <theme>', 'name of the theme (default, dark)', String, 'default')
        .option('-d, --daemonize', 'run as daemon')
        .option('-U, --user <username>',
            'Basic Authentication username, this option works only along with -P option', String, false)
        .option('-P, --password <password>',
            'Basic Authentication password, this option works only along with -U option', String, false)
        .option('-k, --key <path/to/key.pem>', 'Private Key for HTTPS', String, false)
        .option('-c, --certificate <path/to/cert.pem>', 'Certificate for HTTPS', String, false)
        .option('--pid-path <path>',
            'if run as daemon file that will store the process id, default /var/run/frontail.pid',
            String, '/var/run/frontail.pid')
        .option('--log-path <path>', 'if run as daemon file that will be used as a log, default /dev/null',
            String, '/dev/null')
        .parse(process.argv);

    /**
     * Validate args
     */
    var doAuthorization = false;
    var doSecure = false;
    var sessionSecret = null;
    var sessionKey = null;
    var filesNamespace = null;
    if (program.args.length === 0) {
        console.error('Arguments needed, use --help');
        process.exit();
    } else {
        if (program.user && program.password) {
            doAuthorization = true;
            sessionSecret = String(+new Date()) + Math.random();
            sessionKey = 'sid';
        }

        if (program.key && program.certificate) {
            doSecure = true;
        }

        filesNamespace = crypto.createHash('md5').update(program.args.join(' ')).digest('hex');
    }

    if (program.daemonize) {
        /**
         * Daemonize process
         */
        var logFile = fs.openSync(program.logPath, 'a');
        var args = ['-p', program.port, '-n', program.number, '-l', program.lines, '-t', program.theme];

        if (doAuthorization) {
            args = args.concat(['-U', program.user, '-P', program.password]);
        }

        args = args.concat(program.args);

        var proc = daemon.daemon(
            __filename,
            args,
            {
                stdout: logFile,
                stderr: logFile
            }
        );
        fs.writeFileSync(program.pidPath, proc.pid);
    } else {
        /**
         * HTTP server setup
         */
        var appBuilder = connectBuilder();
        if (doAuthorization) {
            appBuilder.session(sessionSecret, sessionKey);
            appBuilder.authorize(program.user, program.password);
        }
        appBuilder
            .static(__dirname + '/lib/web/assets')
            .index(__dirname + '/lib/web/index.html', program.args.join(' '), filesNamespace, program.theme);

        var builder = serverBuilder();
        if (doSecure) {
            builder.secure(program.key, program.certificate);
        }
        var server = builder
            .use(appBuilder.build())
            .port(program.port)
            .host(program.host)
            .build();

        /**
         * socket.io setup
         */
        var io = socketio.listen(server, {log: false});

        if (doAuthorization) {
            io.set('authorization', function (handshakeData, accept) {
                if (handshakeData.headers.cookie) {
                    var cookie = cookieParser.parse(handshakeData.headers.cookie);
                    var sessionId = connect.utils.parseSignedCookie(cookie[sessionKey], sessionSecret);
                    if (sessionId) {
                        return accept(null, true);
                    }
                    return accept('Invalid cookie', false);
                } else {
                    return accept('No cookie in header', false);
                }
            });
        }

        /**
         * When connected send starting data
         */
        var tailer = tail(program.args, {buffer: program.number});
        var filesSocket = io.of('/' + filesNamespace).on('connection', function (socket) {
            socket.emit('options:lines', program.lines);

            tailer.getBuffer().forEach(function (line) {
                socket.emit('line', line);
            });
        });

        /**
         * Send incoming data
         */
        tailer.on('line', function (line) {
            filesSocket.emit('line', sanitizer(line).xss());
        });
    }
})();
