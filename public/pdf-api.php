<?php
require 'vendor/autoload.php';

use Dompdf\Dompdf;
use Dompdf\Options;

// header('Access-Control-Allow-Origin: *');
// header('Access-Control-Allow-Methods: POST');
// header('Access-Control-Allow-Headers: Content-Type');
header('Content-Type: application/json');

try {
    $input = json_decode(file_get_contents('php://input'), true);
    
    if (!isset($input['html']) || !isset($input['fileName']) || !isset($input['serverUrl'])) {
        echo json_encode(['success' => false, 'error' => 'Missing required parameters']);
        exit;
    }

    $htmlContent = $input['html'];
    $pdfFileName = $input['fileName'];
    $nodeServerUrl = $input['serverUrl'];

    $options = new Options();
    $options->set('isHtml5ParserEnabled', true);
    $options->set('isRemoteEnabled', true);
    $options->set('dpi', 96);
    $options->setDefaultFont('Poppins');

    $dompdf = new Dompdf($options);
    $dompdf->loadHtml($htmlContent);
    $dompdf->setPaper('A4', 'portrait');
    $dompdf->render();

    $pdfOutput = $dompdf->output();

    $data = [
        'file' => base64_encode($pdfOutput),
        'fileName' => $pdfFileName,
        'dirName' => $input['savePdfDir']
    ];
    $headers = [
        'Content-Type: application/json',
    ];

    $ch = curl_init($nodeServerUrl);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);

    $response = curl_exec($ch);

    if (curl_errno($ch)) {
        echo json_encode(['success' => false, 'error' => curl_error($ch)]);
    } else {
        echo json_encode(['success' => true, 'php_response' => json_decode($response)]);
    }
} catch (Exception $e) {
    echo json_encode(['success' => false, 'error' => $e->getMessage()]);
}
